// Daily fetch scheduler — Phase 2.
import cron from 'node-cron';
import pino from 'pino';
import { AuthError, DateRange, SessionStore } from './core/types.js';
import { DbSessionStore, getSessionState, listAccounts } from './db/repo.js';
import { runFetchJob } from './fetch-job.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

/** Business-date range in the merchant's timezone: [today - trailingDays, today]. */
export function trailingRange(timezone: string, trailingDays: number, now = new Date()): DateRange {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); // en-CA formats as YYYY-MM-DD
  return {
    from: fmt.format(new Date(now.getTime() - trailingDays * 86_400_000)),
    to: fmt.format(now),
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Retry with backoff. AuthError never retries — hammering a broken login risks platform lockout. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: number[] = [60_000, 300_000],
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AuthError || attempt >= delaysMs.length) throw err;
      logger.warn({ err: (err as Error).message, attempt }, 'Fetch failed, retrying after backoff');
      await sleepFn(delaysMs[attempt]);
    }
  }
}

/**
 * One pass over every account: re-fetch the trailing window so late status
 * changes (cancellations, refunds) get picked up by the upsert.
 * ponytail: sequential loop IS the per-platform semaphore (no concurrent Playwright
 * logins); parallelize per-platform when account count makes this slow.
 */
export async function runAllAccounts(
  sessionStore: SessionStore = new DbSessionStore(),
  trailingDays = Number(process.env.FETCH_TRAILING_DAYS ?? 2),
): Promise<void> {
  for (const account of listAccounts()) {
    if (getSessionState(account.id) === 'needs_human') {
      logger.warn({ accountId: account.id }, 'Skipping: needs human re-auth (pnpm cli import-session)');
      continue;
    }
    const range = trailingRange(account.timezone, trailingDays);
    try {
      const orders = await withRetry(() => runFetchJob(account, range, sessionStore));
      logger.info({ accountId: account.id, ...range, count: orders.length }, 'Scheduled fetch complete');
    } catch (err: any) {
      // runFetchJob already logged the run to fetch_runs (and marked needs_human on AuthError)
      if (err instanceof AuthError) {
        // TODO Phase 3: Telegram alert via grammY
        logger.error({ accountId: account.id, err: err.message }, 'AUTH BROKEN — human needed (pnpm cli import-session)');
      } else {
        logger.error({ accountId: account.id, err: err.message }, 'Scheduled fetch failed after retries');
      }
    }
  }
}

export function startScheduler(): void {
  const expr = process.env.SCHEDULE_CRON ?? '30 6 * * *'; // daily 06:30, server-local time
  let running = false; // ponytail: global overlap guard; per-account locks if runs ever exceed a day
  cron.schedule(expr, async () => {
    if (running) {
      logger.warn('Previous scheduled run still in progress, skipping this tick');
      return;
    }
    running = true;
    try {
      await runAllAccounts();
    } finally {
      running = false;
    }
  });
  logger.info({ cron: expr }, 'Scheduler started');
}
