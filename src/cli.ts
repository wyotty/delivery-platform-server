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
import { DateRange } from './core/types.js';

registerConnector(new GrabConnector());

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

function usage(): never {
  // `pnpm run fetch`, not `pnpm fetch` — pnpm has its own built-in `fetch`
  // command that would shadow the script and silently do nothing.
  console.error('Usage: pnpm run fetch <platform> <account_id> [from] [to]');
  console.error('       pnpm cli import-session <account_id> <session.json>');
  console.error('Example: pnpm run fetch grab grab-dong-day 2026-07-26');
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
    }, null, 2));
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
