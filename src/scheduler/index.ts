import cron, { ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import { Config } from '../config/index.js';
import { SessionStore } from '../core/types.js';
import { yesterdayIn } from '../core/dates.js';
import { buildAccount, fetchAndStore } from '../core/fetch-service.js';
import { listAccounts } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

/**
 * Fetch yesterday for every configured account.
 *
 * "Yesterday" is resolved per account in that account's own timezone — a server
 * running in UTC must not decide what yesterday means for a Ho Chi Minh merchant.
 * One account failing must not stop the others, so each is caught individually.
 */
export async function runDailyFetch(
  sessionStore: SessionStore,
  logger: Logger,
  notifier?: Notifier,
): Promise<void> {
  const accounts = listAccounts();
  if (accounts.length === 0) {
    logger.warn('Daily fetch skipped — no platform accounts configured');
    return;
  }

  logger.info({ accountCount: accounts.length }, 'Daily fetch starting');

  for (const row of accounts) {
    const date = yesterdayIn(row.timezone);
    try {
      const account = buildAccount(row.id);
      await fetchAndStore(account, { from: date, to: date }, sessionStore, logger, notifier);
    } catch (err) {
      // Already logged and alerted inside fetchAndStore; keep going so a single
      // broken account cannot block every other merchant's nightly fetch.
      logger.error({ err, accountId: row.id, date }, 'Daily fetch failed for account');
    }
  }

  logger.info('Daily fetch finished');
}

export function startScheduler(
  config: Config,
  sessionStore: SessionStore,
  logger: Logger,
  notifier?: Notifier,
): ScheduledTask {
  if (!cron.validate(config.fetchCron)) {
    throw new Error(`Invalid FETCH_CRON expression: ${config.fetchCron}`);
  }

  const task = cron.schedule(
    config.fetchCron,
    () => {
      void runDailyFetch(sessionStore, logger, notifier).catch(err =>
        logger.error({ err }, 'Daily fetch crashed'),
      );
    },
    { timezone: config.cronTimezone },
  );

  logger.info({ cron: config.fetchCron, timezone: config.cronTimezone }, 'Scheduler started');
  return task;
}
