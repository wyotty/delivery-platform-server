#!/usr/bin/env tsx
// CLI composition root — registers connectors, then delegates to the same fetch
// service the scheduler uses, so both paths behave identically.
import 'dotenv/config';
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
  console.error('Usage: pnpm run fetch <platform> <account_id> [from] [to]');
  console.error('Example: pnpm run fetch grab grab-dong-day 2026-07-26');
  process.exit(1);
}

async function main() {
  const [command, platform, accountId, from, to] = process.argv.slice(2);
  if (command !== 'fetch' || !platform || !accountId) usage();

  const start = from ?? new Date().toISOString().slice(0, 10);
  const range: DateRange = { from: start, to: to ?? start };

  const account = buildAccount(accountId, platform);
  const result = await fetchAndStore(account, range, sessionStore, logger);

  console.log(JSON.stringify({
    total_orders: result.totalOrders,
    completed: result.completed,
    revenue_minor: result.revenueMinor,
  }, null, 2));
}

main().catch(err => {
  logger.error({ err }, 'Fatal');
  process.exit(1);
});
