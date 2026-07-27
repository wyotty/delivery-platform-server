import type { Logger } from 'pino';
import { getConnector } from './registry.js';
import { AuthError, DateRange, PlatformAccount, SessionStore } from './types.js';
import { getAccount, logFetchRun, setSessionState, upsertOrders } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

export interface FetchResult {
  accountId: string;
  totalOrders: number;
  completed: number;
  revenueMinor: number;
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
    config: JSON.parse(row.config),
  };
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
    const orders = await connector.fetchOrders(account, range, sessionStore);
    upsertOrders(orders);

    // Revenue = completed orders only; cancelled Grab statements can still carry earnings.
    const completed = orders.filter(o => o.status === 'completed');
    const revenueMinor = completed.reduce((sum, o) => sum + o.netAmountMinor, 0);

    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: 'success',
      orderCount: orders.length,
      startedAt,
      completedAt: new Date().toISOString(),
    });

    logger.info({ totalOrders: orders.length, completed: completed.length, revenueMinor }, 'Fetch complete');
    return { accountId: account.id, totalOrders: orders.length, completed: completed.length, revenueMinor };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: 'failure',
      orderCount: 0,
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
