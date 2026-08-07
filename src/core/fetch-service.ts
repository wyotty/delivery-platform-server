import type { Logger } from 'pino';
import { getConnector } from './registry.js';
import { AuthError, DateRange, PlatformAccount, SessionStore, getPartialOrders } from './types.js';
import { getAccount, getStoredOrderDetail, logFetchRun, setSessionState, upsertOrders } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

export interface FetchResult {
  accountId: string;
  totalOrders: number;
  completed: number;
  revenueMinor: number;
  /** Orders whose line items were (re)written this run. */
  itemsWritten: number;
  /**
   * Orders whose detail was not fetched because nothing about them had changed —
   * no call made, no row touched. On a quiet 3-minute tick this is every order, and
   * it is the number that says the incremental path is doing its job.
   */
  itemsSkipped: number;
  /** Orders whose detail call never produced a payload — stored lines untouched. */
  itemsMissing: number;
  /** Orders that had a payload but whose line-item write was refused or failed. */
  itemFailures: number;
  /**
   * Orders nothing could be stored for — a value bound to a NOT NULL column could
   * not be read. Not a partial write: there is no row, so they are in no total.
   */
  orderFailures: number;
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
 * The identity of a failure, for the alert throttle (see notify/ThrottledNotifier).
 *
 * WHICH orders and WHY, sorted — so the same broken order reporting the same reason on
 * the next tick is recognized as the same condition and stays quiet, while a different
 * order, or the same one failing a new way, is a new condition and alerts at once.
 *
 * Deliberately NOT the message: that carries the date range, which rolls over at
 * midnight and would un-mute every condition once a day for no reason, and the stored
 * count, which moves whenever an unrelated order lands.
 */
function failureKey(kind: string, accountId: string, entries: { platformOrderId: string; error: string }[]): string {
  return `${kind}:${accountId}:${entries.map(e => `${e.platformOrderId}=${e.error}`).sort().join('|')}`;
}

/**
 * The identity of a free-text error message, with the parts that move on their own
 * taken out.
 *
 * A message is only usable as a throttle key if it is the same string while the
 * condition is the same condition, and error messages are not written with that in
 * mind: the login gate's says when it will next try ('next attempt after
 * 2026-08-07T01:00:00.000Z') and how many failures it has seen, both of which change
 * while nothing about the situation does. Keyed raw, a broken login alerted ~24 times
 * a day (measured over a simulated day of 3-minute ticks) — better than 480, and still
 * not what "alert once" means.
 *
 * Every run of digits, deliberately: this has to work on messages nobody here wrote,
 * including Playwright's. The cost is that 'HTTP 500' and 'HTTP 503' share a key for
 * one throttle window; both mean "the API is refusing us", the exact text is in
 * fetch_runs and the log line, and the alternative is a taxonomy of error strings that
 * would go stale the first time a dependency reworded one.
 */
function conditionKey(message: string): string {
  return message.replace(/\d+/g, '#');
}

export interface FetchAndStoreOptions {
  /**
   * Re-fetch every order's detail, ignoring what is already stored.
   *
   * The opt-out from incremental fetching, and the only way to repair rows the store
   * believes are already correct — after a parser fix, or for orders written before a
   * column existed. Off by default, deliberately: the scheduled path runs 480 times a
   * day, and a full re-fetch of a 3-day window there is ~980 calls an hour at a live
   * merchant — for bytes that have not changed.
   */
  force?: boolean;
}

/**
 * Fetch a date range for one account, persist the orders, and record the run.
 *
 * Auth failures record the session state and raise an alert. Neither is what BOUNDS a
 * broken login — the connector's process-level login gate is, because this function is
 * called 480 times a day and each call knows nothing about the last one — but both are
 * how a human finds out, and the alert is keyed so that "480 times a day" is one
 * message rather than 480.
 */
export async function fetchAndStore(
  account: PlatformAccount,
  range: DateRange,
  sessionStore: SessionStore,
  logger: Logger,
  notifier?: Notifier,
  opts: FetchAndStoreOptions = {},
): Promise<FetchResult> {
  const startedAt = new Date().toISOString();
  logger.info({ platform: account.platform, accountId: account.id, ...range, force: opts.force === true }, 'Fetching orders');

  try {
    const connector = getConnector(account.platform);
    // This is the only place the two halves meet: the connector knows what the
    // platform just said, the repo knows what we already hold, and the decision that
    // needs both is a pure function over them (core/detail-refresh.ts). Omitting the
    // lookup entirely is what --force means — see FetchOrdersOptions.storedDetail.
    const orders = await connector.fetchOrders(account, range, sessionStore, {
      logger,
      storedDetail: opts.force ? undefined : (reportDate => getStoredOrderDetail(account.id, reportDate)),
    });
    const { orderFailures, itemFailures, stored, itemsWritten } = upsertOrders(orders);

    // Revenue = completed orders only; cancelled Grab statements can still carry
    // earnings. Over `stored` rather than `orders`: an order rejected for an
    // unreadable net amount would otherwise be added to this sum, and `0 + {}` is
    // '0[object Object]' — a run summary that is not even a number.
    const completed = stored.filter(o => o.status === 'completed');
    const revenueMinor = completed.reduce((sum, o) => sum + o.netAmountMinor, 0);

    // Three different ways a night falls short of a full success, in descending order
    // of what they cost:
    //   orderFailures — the order could not be stored at all. A value bound to a NOT
    //     NULL column was unreadable, so there is no row: the order is absent from
    //     every total and every report, not merely incomplete in one. A payload that
    //     keeps its new shape keeps failing, so this pages someone.
    //   itemFailures — a payload arrived and the line-item write was REFUSED
    //     (replaceOrderItems will not overwrite real lines with a suspect payload).
    //     That refusal repeats every single night, so the stored lines stay frozen
    //     until a human looks. Nothing else surfaces it: items_fetched_at merely
    //     stops advancing.
    //   itemsMissing — the detail call never produced a payload (HTTP 500, the
    //     deadline, a booking-code-only statement). Stored lines are untouched and
    //     tomorrow's trailing re-fetch retries the order, so this is logged, not alerted.
    // Over `stored` as well: an order that has no row has no lines to be missing,
    // and reporting it twice would spend the alert's three-entry budget saying the
    // same thing less usefully — its platformOrderId is one of the things that may
    // not have been readable.
    const missing = stored
      .filter(o => o.itemsError)
      .map(o => ({ platformOrderId: o.platformOrderId, error: o.itemsError! }));

    // Neither a payload nor an error: the connector decided this order did not need
    // looking at. Not a shortfall of any kind, so it stays out of `reasons` and out of
    // the run status — an unchanged order is the expected case, 480 times a day.
    const itemsSkipped = stored.filter(o => o.items === undefined && o.itemsError === undefined).length;

    const reasons: string[] = [];
    if (orderFailures.length > 0) reasons.push(summarizeFailures('order(s) that could not be stored', orderFailures));
    if (itemFailures.length > 0) reasons.push(summarizeFailures('order(s) whose line items could not be written', itemFailures));
    if (missing.length > 0) reasons.push(summarizeFailures('order(s) with no item detail', missing));

    if (orderFailures.length > 0) logger.warn({ orderFailures, stored: stored.length }, 'Some orders could not be stored at all');
    if (itemFailures.length > 0) logger.warn({ itemFailures, itemsWritten }, 'Line items could not be written for some orders');
    if (missing.length > 0) logger.warn({ missing }, 'Some orders have no item detail this run');

    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: reasons.length > 0 ? 'partial' : 'success',
      // What landed, not what was fetched — the same thing this column means on the
      // failure path below. The two are equal on every run but a rejecting one.
      orderCount: stored.length,
      errorMessage: reasons.length > 0 ? reasons.join(' — ') : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    // Two alerts, because they are two different losses, and one is not the other's
    // headline: a refused item write freezes lines that exist, an unstorable order
    // has no row to freeze. A missing detail call repairs itself tomorrow and alerts
    // for neither.
    //
    // Both are conditions rather than events — the same bad order is rediscovered on
    // every one of the day's 480 runs — so both are keyed for the throttle. Unkeyed,
    // one unstorable order sent 480 identical Telegram messages a day (measured).
    if (orderFailures.length > 0) {
      await notifier?.alert(
        `🔴 ${account.platform} could not store ${orderFailures.length} of ${orders.length} orders for ${account.merchantName} (${account.id}) — ` +
        `those orders are in no total\n` +
        `Range: ${range.from}..${range.to}\n${summarizeFailures('order(s)', orderFailures)}`,
        failureKey('orderFailures', account.id, orderFailures),
      );
    }
    if (itemFailures.length > 0) {
      await notifier?.alert(
        `⚠️ ${account.platform} stored ${stored.length} orders for ${account.merchantName} (${account.id}), ` +
        `but ${itemFailures.length} could not have their line items written — those lines are now stale\n` +
        `Range: ${range.from}..${range.to}\n${summarizeFailures('order(s)', itemFailures)}`,
        failureKey('itemFailures', account.id, itemFailures),
      );
    }

    logger.info(
      { totalOrders: orders.length, stored: stored.length, completed: completed.length, revenueMinor, itemsWritten, itemsSkipped, itemsMissing: missing.length, itemFailures: itemFailures.length, orderFailures: orderFailures.length },
      'Fetch complete',
    );
    return {
      accountId: account.id,
      totalOrders: orders.length,
      completed: completed.length,
      revenueMinor,
      itemsWritten,
      itemsSkipped,
      itemsMissing: missing.length,
      itemFailures: itemFailures.length,
      orderFailures: orderFailures.length,
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
        const result = upsertOrders(salvaged);
        // What actually landed, so orderCount below never claims an order the writer
        // refused. The salvage path runs the same guard as every other write.
        stored = result.stored.length;
        // The run is already 'failure' and the abort is the headline, but a refused
        // item write is a separate, silent, permanent problem — it must not vanish
        // just because something else failed louder in the same run. An order that
        // could not be stored at all is the same kind of quiet, worse.
        if (result.orderFailures.length > 0) {
          logger.warn({ orderFailures: result.orderFailures }, 'Some salvaged orders could not be stored at all');
        }
        if (result.itemFailures.length > 0) {
          logger.warn({ itemFailures: result.itemFailures }, 'Line items could not be written for some salvaged orders');
        }
        logger.warn({ stored, itemsWritten: result.itemsWritten }, 'Fetch aborted — stored the orders collected before it failed');
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

    // Keyed for the same reason, and it matters most here: a broken login fails every
    // tick by construction, and the message is identical every time. The login gate is
    // what stops the retrying; this is what stops the reporting of it. The failure text
    // is part of the key, so 'session expired' turning into 'login held back — backing
    // off' is a new thing to say and says it immediately.
    if (err instanceof AuthError) {
      setSessionState(account.id, err.authState);
      await notifier?.alert(
        `🔴 ${account.platform} auth ${err.authState} for ${account.merchantName} (${account.id})\n` +
        `Range: ${range.from}..${range.to}\n${message}`,
        `auth:${account.id}:${err.authState}:${conditionKey(message)}`,
      );
    } else {
      await notifier?.alert(
        `⚠️ ${account.platform} fetch failed for ${account.merchantName} (${account.id})\n` +
        `Range: ${range.from}..${range.to}\n${message}`,
        `fetchFailed:${account.id}:${conditionKey(message)}`,
      );
    }

    logger.error({ err }, 'Fetch failed');
    throw err;
  }
}
