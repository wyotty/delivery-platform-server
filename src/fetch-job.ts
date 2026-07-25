// Shared fetch flow — the single path both the CLI and the scheduler run.
import { getConnector } from './core/registry.js';
import { upsertOrders, logFetchRun, markSessionNeedsHuman, PlatformAccountRow } from './db/repo.js';
import { AuthError, DateRange, PlatformAccount, SessionStore, UnifiedOrder } from './core/types.js';

export function buildAccount(row: PlatformAccountRow): PlatformAccount {
  // ponytail: env prefix from platform name; key off credentialKey when one platform needs multiple credential sets
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
 * Fetch + upsert + log to fetch_runs. Throws on failure (after logging).
 * An AuthError escaping the connector means auto-recovery already failed —
 * the session is marked needs_human so the scheduler skips the account until re-auth.
 */
export async function runFetchJob(
  row: PlatformAccountRow,
  range: DateRange,
  sessionStore: SessionStore,
): Promise<UnifiedOrder[]> {
  const account = buildAccount(row);
  const connector = getConnector(row.platform);
  const startedAt = new Date().toISOString();

  try {
    const orders = await connector.fetchOrders(account, range, sessionStore);
    upsertOrders(orders);
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
    return orders;
  } catch (err: any) {
    if (err instanceof AuthError) markSessionNeedsHuman(account.id);
    logFetchRun({
      platform: account.platform,
      accountId: account.id,
      dateFrom: range.from,
      dateTo: range.to,
      status: 'failure',
      orderCount: 0,
      errorMessage: err.message,
      startedAt,
      completedAt: new Date().toISOString(),
    });
    throw err;
  }
}
