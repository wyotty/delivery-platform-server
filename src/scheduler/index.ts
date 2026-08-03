import cron, { ScheduledTask } from 'node-cron';
import type { Logger } from 'pino';
import { Config } from '../config/index.js';
import { AuthError, DateRange, SessionStore } from '../core/types.js';
import { dateInTz } from '../core/dates.js';
import { buildAccount, fetchAndStore } from '../core/fetch-service.js';
import { getSessionState, listAccounts } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

/**
 * Business-date range in the merchant's timezone: [today - trailingDays, today].
 * Resolved per account in that account's own timezone — a server running in UTC
 * must not decide what "today" means for a Ho Chi Minh merchant.
 */
export function trailingRange(timezone: string, trailingDays: number, now = new Date()): DateRange {
  return {
    from: dateInTz(new Date(now.getTime() - trailingDays * 86_400_000), timezone),
    to: dateInTz(now, timezone),
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Retry with backoff. AuthError never retries — hammering a broken login risks platform lockout. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [60_000, 300_000],
  sleepFn: (ms: number) => Promise<void> = sleep,
  logger?: Logger,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError || attempt >= delaysMs.length) throw err;
      logger?.warn({ err: (err as Error).message, attempt }, 'Fetch failed, retrying after backoff');
      await sleepFn(delaysMs[attempt]);
    }
  }
}

/**
 * One pass over every account, re-fetching the trailing window so late status
 * changes (cancellations, refunds) are picked up by the upsert.
 *
 * One account failing must not stop the others, so each is caught individually.
 * ponytail: sequential loop IS the per-platform semaphore (no concurrent Playwright
 * logins); parallelize per-platform when account count makes this slow.
 */
export async function runDailyFetch(
  config: Config,
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
    if (getSessionState(row.id) === 'needs_human') {
      logger.warn({ accountId: row.id }, 'Skipping: needs human re-auth (pnpm cli import-session)');
      continue;
    }

    const range = trailingRange(row.timezone, config.fetchTrailingDays);
    try {
      const account = buildAccount(row.id);
      await withRetry(
        () => fetchAndStore(account, range, sessionStore, logger, notifier),
        undefined,
        undefined,
        logger,
      );
    } catch (err) {
      // Already logged and alerted inside fetchAndStore; keep going so a single
      // broken account cannot block every other merchant's nightly fetch.
      logger.error({ err, accountId: row.id, ...range }, 'Daily fetch failed for account');
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

  let running = false; // ponytail: global overlap guard; per-account locks if runs ever exceed a day
  const task = cron.schedule(
    config.fetchCron,
    () => {
      if (running) {
        logger.warn('Previous scheduled run still in progress, skipping this tick');
        return;
      }
      running = true;
      void runDailyFetch(config, sessionStore, logger, notifier)
        .catch(err => logger.error({ err }, 'Daily fetch crashed'))
        .finally(() => { running = false; });
    },
    { timezone: config.cronTimezone },
  );

  logger.info({ cron: config.fetchCron, timezone: config.cronTimezone }, 'Scheduler started');
  return task;
}
