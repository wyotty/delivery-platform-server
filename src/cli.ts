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
  console.error('Usage: pnpm run fetch <platform> <account_id> [from] [to] [--force]');
  console.error('       pnpm cli backfill <platform> <account_id> <from> <to> [--force]');
  console.error('       pnpm cli import-session <account_id> <session.json>');
  console.error('');
  console.error('Order-level data (status, totals, revenue) is always re-fetched: it is one');
  console.error('request per day. Per-order LINE ITEMS are a request per order at ~1/sec, and');
  console.error('by default only orders that need one get one — an order the platform has not');
  console.error('touched since we last stored its lines is left exactly as it is.');
  console.error('');
  console.error('  --force  re-fetch every order\'s line items, even unchanged ones. Use after a');
  console.error('           parser fix or a schema change, when what is stored is wrong rather');
  console.error('           than merely old. Costs ~1 second per order in the range.');
  console.error('');
  console.error('Example: pnpm run fetch grab grab-dong-day 2026-07-26');
  console.error('         pnpm cli backfill grab grab-dong-day 2026-06-01 2026-06-30');
  console.error('         pnpm cli backfill grab grab-dong-day 2026-06-01 2026-06-30 --force');
  process.exit(1);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);

  // Flags stripped before the positionals are read, so `--force` may sit anywhere on
  // the line without silently becoming a date. An unknown --flag is refused rather
  // than ignored: a mistyped --forse that quietly ran an incremental fetch would look
  // exactly like a successful forced one.
  const flags = argv.filter(a => a.startsWith('--'));
  const args = argv.filter(a => !a.startsWith('--'));
  const unknown = flags.filter(f => f !== '--force');
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown.join(' ')}`);
    usage();
  }
  const force = flags.includes('--force');

  if (command === 'fetch') {
    const [platform, accountId, from, to] = args;
    if (!platform || !accountId) usage();

    const start = from ?? new Date().toISOString().slice(0, 10);
    const range: DateRange = { from: start, to: to ?? start };

    const account = buildAccount(accountId, platform);
    const result = await fetchAndStore(account, range, sessionStore, logger, undefined, { force });

    console.log(JSON.stringify({
      total_orders: result.totalOrders,
      completed: result.completed,
      revenue_minor: result.revenueMinor,
      // Non-zero here means the run was recorded 'partial', not 'success' — the
      // order-level rows landed but some lines did not. Printed because a backfill
      // that silently skipped line items looks identical to one that worked.
      items_written: result.itemsWritten,
      // Orders left alone because nothing about them had changed. Without --force this
      // is normally most of them, and a 0 here on a re-run is the sign that something
      // is making every order look new.
      items_skipped: result.itemsSkipped,
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
    //
    // Incremental by default like every other path, which makes re-running a range
    // nearly free: only the orders that still lack current lines are called for. Pass
    // --force when the stored lines are wrong rather than missing (a parser fix), and
    // every order in the range is fetched again.
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
        const result = await fetchAndStore(account, { from: date, to: date }, sessionStore, logger, undefined, { force });
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
    console.log(JSON.stringify({ days: dates.length, force, ok, failed: failedDays, skipped }, null, 2));
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
