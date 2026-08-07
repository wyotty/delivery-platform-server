#!/usr/bin/env tsx
// CLI composition root — registers connectors, then delegates to the same fetch
// service the scheduler uses, so both paths behave identically.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pino from 'pino';
import { registerConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { DbSessionStore } from './db/repo.js';
import { buildAccount, fetchAndStore } from './core/fetch-service.js';
import { eachDate } from './core/dates.js';
import { AuthError, DateRange } from './core/types.js';

registerConnector(new GrabConnector());

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

function usage(): never {
  // `pnpm run fetch`, not `pnpm fetch` — pnpm has its own built-in `fetch`
  // command that would shadow the script and silently do nothing.
  console.error('Usage: pnpm run fetch <platform> <account_id> [from] [to]');
  console.error('       pnpm cli backfill <platform> <account_id> <from> <to>');
  console.error('       pnpm cli import-session <account_id> <session.json>');
  console.error('Example: pnpm run fetch grab grab-dong-day 2026-07-26');
  console.error('         pnpm cli backfill grab grab-dong-day 2026-06-01 2026-06-30');
  process.exit(1);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'fetch') {
    const [platform, accountId, from, to] = args;
    if (!platform || !accountId) usage();

    const start = from ?? new Date().toISOString().slice(0, 10);
    const range: DateRange = { from: start, to: to ?? start };

    const account = buildAccount(accountId, platform);
    const result = await fetchAndStore(account, range, sessionStore, logger);

    console.log(JSON.stringify({
      total_orders: result.totalOrders,
      completed: result.completed,
      revenue_minor: result.revenueMinor,
      // Non-zero here means the run was recorded 'partial', not 'success' — the
      // order-level rows landed but some lines did not. Printed because a backfill
      // that silently skipped line items looks identical to one that worked.
      items_written: result.itemsWritten,
      items_missing: result.itemsMissing,
      item_failures: result.itemFailures,
      // Orders that landed nowhere at all: total_orders above counts what Grab
      // returned, and this is how many of them are missing from the database.
      order_failures: result.orderFailures,
    }, null, 2));
  } else if (command === 'backfill') {
    // Existing orders predate line-item collection. This is the same connector, the
    // same auth retry, the same rate limit and the same upsert the scheduler runs —
    // there is deliberately no items-only shortcut, because a second write path is a
    // second place to forget when the schema changes. Idempotent, so re-running a
    // day that already landed is always safe.
    const [platform, accountId, from, to] = args;
    if (!platform || !accountId || !from || !to) usage();

    const account = buildAccount(accountId, platform);
    // One fetchAndStore per day, not one call for the whole range: a month is ~1300
    // sequential detail calls, and a single call for the lot would be all-or-nothing,
    // silent for 20 minutes, and one fetch_runs row for the whole thing. Per day gives
    // a run row per day, a progress line every ~45s, and resumability.
    const dates = eachDate(from, to); // validates the range and its format
    const failedDays: string[] = [];
    let ok = 0;
    let stoppedAt = -1;

    for (const [i, date] of dates.entries()) {
      try {
        const result = await fetchAndStore(account, { from: date, to: date }, sessionStore, logger);
        ok++;
        logger.info(
          { date, ...result, remaining: dates.length - ok - failedDays.length },
          'Backfilled day',
        );
      } catch (err) {
        // Mirrors runDailyFetch's per-account catch: one bad day must not cost the
        // other 29. fetchAndStore has already logged, alerted and written the run row.
        failedDays.push(date);
        logger.error({ date, err }, 'Backfill day failed');

        if (err instanceof AuthError) {
          // Auth is broken for the account, not for this date — every remaining day
          // would fail the same way, each one driving another headless login against a
          // live production account. That is the lockout the scheduler refuses to risk
          // (withRetry never retries AuthError), and a backfill loop is 30 chances at it.
          stoppedAt = i;
          logger.error(
            { skipped: dates.length - i - 1, resumeFrom: dates[i + 1] },
            'Auth broke — stopping. Re-auth (pnpm cli import-session), then re-run from the skipped day',
          );
          break;
        }
      }
    }

    const skipped = stoppedAt >= 0 ? dates.slice(stoppedAt + 1) : [];
    console.log(JSON.stringify({ days: dates.length, ok, failed: failedDays, skipped }, null, 2));
    // Non-zero so a wrapper script notices; skipped days are a failure too, not a pass.
    if (failedDays.length > 0) process.exitCode = 1;
  } else if (command === 'import-session') {
    // Recovery path for needs_human: paste a session captured manually (browser devtools)
    const [accountId, file] = args;
    if (!accountId || !file) usage();

    buildAccount(accountId); // fails loudly if the account isn't seeded

    const session = JSON.parse(readFileSync(file, 'utf8'));
    // Manually exported sessions rarely include our bookkeeping timestamp — stamp it now
    if (session && typeof session === 'object' && !('fetchedAt' in session)) {
      session.fetchedAt = Math.floor(Date.now() / 1000);
    }
    await sessionStore.set(accountId, session); // resets state to 'valid' — scheduler resumes this account
    logger.info({ accountId }, 'Session imported — scheduler will resume this account');
  } else {
    usage();
  }
}

main().catch(err => {
  logger.error({ err }, 'Fatal');
  process.exit(1);
});
