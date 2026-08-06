import type { Logger } from 'pino';
import { getConnector } from './registry.js';
import { AuthError, DateRange, PlatformAccount, SessionStore, getPartialOrders } from './types.js';
import { getAccount, logFetchRun, setSessionState, upsertOrders } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

export interface FetchResult {
  accountId: string;
  totalOrders: number;
  completed: number;
  revenueMinor: number;
  /** Orders whose line items were (re)written this run. */
  itemsWritten: number;
  /** Orders whose detail call never produced a payload — stored lines untouched. */
  itemsMissing: number;
  /** Orders that had a payload but whose line-item write was refused or failed. */
  itemFailures: number;
}

/**
 * Build the runtime account from the DB row plus credentials in the environment.
 * The DB is the single source of truth for *which* accounts exist and how they
 * behave; secrets never live in it.
 */
export function buildAccount(accountId: string, platform?: string): PlatformAccount {
  const row = getAccount(accountId);
  if (!row) throw new Error(`Account not found: ${accountId}. Run the seed script first.`);
  if (platform && row.platform !== platform) {
    throw new Error(`Account ${accountId} belongs to platform '${row.platform}', not '${platform}'.`);
  }

  // Env prefix comes from the platform name; key off credentialKey when one
  // platform eventually needs multiple credential sets.
  const envPrefix = row.platform.toUpperCase();
  return {
    id: row.id,
    platform: row.platform,
    merchantId: row.merchantId,
    merchantName: row.label,
    credentials: {
      username: process.env[`${envPrefix}_USERNAME`] || '',
      password: process.env[`${envPrefix}_PASSWORD`] || '',
    },
    timezone: row.timezone,
    // Degrade to defaults rather than throw: config is hand-edited (it holds the
    // item-detail kill switch), and a typo must not take the account's nightly
    // fetch down with it.
    config: parseAccountConfig(row.config),
  };
}

function parseAccountConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Bounded one-line summary for fetch_runs.error_message and the alert.
 *
 * A bad night can produce one entry per order (~44). Writing 44 error strings into
 * one column makes the column unreadable, and the count is the alarm anyway — the
 * first few are the diagnosis, and the structured log line has all of them.
 */
function summarizeFailures(label: string, entries: { platformOrderId: string; error: string }[]): string {
  const shown = entries.slice(0, 3).map(e => `${e.platformOrderId}: ${e.error}`);
  const rest = entries.length - shown.length;
  return `${entries.length} ${label}: ${shown.join(' | ')}${rest > 0 ? ` | …and ${rest} more` : ''}`;
}

/**
 * Fetch a date range for one account, persist the orders, and record the run.
 * Auth failures mark the session `needs_human` and raise an alert — without that
 * the scheduler would silently retry a broken login every night forever.
 */
export async function fetchAndStore(
  account: PlatformAccount,
  range: DateRange,
  sessionStore: SessionStore,
  logger: Logger,
  notifier?: Notifier,
): Promise<FetchResult> {
  const startedAt = new Date().toISOString();
  logger.info({ platform: account.platform, accountId: account.id, ...range }, 'Fetching orders');

  try {
    const connector = getConnector(account.platform);
    const orders = await connector.fetchOrders(account, range, sessionStore, { logger });
    const { itemFailures, itemsWritten } = upsertOrders(orders);

    // Revenue = completed orders only; cancelled Grab statements can still carry earnings.
    const completed = orders.filter(o => o.status === 'completed');
    const revenueMinor = completed.reduce((sum, o) => sum + o.netAmountMinor, 0);

    // Two different ways a night falls short of a full success, and both used to be
    // recorded as one:
    //   itemsMissing — the detail call never produced a payload (HTTP 500, the
    //     deadline, a booking-code-only statement). Stored lines are untouched and
    //     tomorrow's trailing re-fetch retries the order, so this is logged, not alerted.
    //   itemFailures — a payload arrived and the write was REFUSED (replaceOrderItems
    //     will not overwrite real lines with a suspect payload). That refusal repeats
    //     every single night, so the stored lines stay frozen until a human looks.
    //     Nothing else surfaces it: items_fetched_at merely stops advancing.
    const missing = orders
      .filter(o => o.itemsError)
      .map(o => ({ platformOrderId: o.platformOrderId, error: o.itemsError! }));

    const reasons: string[] = [];
    if (missing.length > 0) reasons.push(summarizeFailures('order(s) with no item detail', missing));
    if (itemFailures.length > 0) reasons.push(summarizeFailures('order(s) whose line items could not be written', itemFailures));

    if (missing.length > 0) logger.warn({ missing }, 'Some orders have no item detail this run');
    if (itemFailures.length > 0) logger.warn({ itemFailures, itemsWritten }, 'Line items could not be written for some orders');

    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: reasons.length > 0 ? 'partial' : 'success',
      orderCount: orders.length,
      errorMessage: reasons.length > 0 ? reasons.join(' — ') : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    // Only the refusals alert. A frozen line-item table repairs itself never; a
    // missing detail call repairs itself tomorrow.
    if (itemFailures.length > 0) {
      await notifier?.alert(
        `⚠️ ${account.platform} stored ${orders.length} orders for ${account.merchantName} (${account.id}), ` +
        `but ${itemFailures.length} could not have their line items written — those lines are now stale\n` +
        `Range: ${range.from}..${range.to}\n${summarizeFailures('order(s)', itemFailures)}`,
      );
    }

    logger.info(
      { totalOrders: orders.length, completed: completed.length, revenueMinor, itemsWritten, itemsMissing: missing.length, itemFailures: itemFailures.length },
      'Fetch complete',
    );
    return {
      accountId: account.id,
      totalOrders: orders.length,
      completed: completed.length,
      revenueMinor,
      itemsWritten,
      itemsMissing: missing.length,
      itemFailures: itemFailures.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // An abort mid-run still carries the orders fetched before it. Per-order detail
    // fetching turned a day into ~45 sequential calls, so dropping them would make
    // an auth break at call #40 cost a whole night of otherwise-good data. The
    // alert below still fires — it just no longer costs the orders.
    const salvaged = getPartialOrders(err);
    let stored = 0;
    if (salvaged.length > 0) {
      try {
        const { itemFailures, itemsWritten } = upsertOrders(salvaged);
        stored = salvaged.length;
        // The run is already 'failure' and the abort is the headline, but a refused
        // item write is a separate, silent, permanent problem — it must not vanish
        // just because something else failed louder in the same run.
        if (itemFailures.length > 0) {
          logger.warn({ itemFailures }, 'Line items could not be written for some salvaged orders');
        }
        logger.warn({ stored, itemsWritten }, 'Fetch aborted — stored the orders collected before it failed');
      } catch (storeErr) {
        logger.error({ err: storeErr }, 'Could not store salvaged orders');
      }
    }

    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: 'failure',
      orderCount: stored,
      errorMessage: message,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    if (err instanceof AuthError) {
      setSessionState(account.id, err.authState);
      await notifier?.alert(
        `🔴 ${account.platform} auth ${err.authState} for ${account.merchantName} (${account.id})\n` +
        `Range: ${range.from}..${range.to}\n${message}`,
      );
    } else {
      await notifier?.alert(
        `⚠️ ${account.platform} fetch failed for ${account.merchantName} (${account.id})\n` +
        `Range: ${range.from}..${range.to}\n${message}`,
      );
    }

    logger.error({ err }, 'Fetch failed');
    throw err;
  }
}
