#!/usr/bin/env tsx
// Composition root — registers connectors, wires up the app
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { registerConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { DbSessionStore, getAccount } from './db/repo.js';
import { runFetchJob } from './fetch-job.js';
import { DateRange } from './core/types.js';
import pino from 'pino';

// Register connectors at startup
registerConnector(new GrabConnector());

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

function usage(): never {
  console.error('Usage: pnpm fetch <platform> <account_id> [from] [to]');
  console.error('       pnpm cli import-session <account_id> <session.json>');
  console.error('Example: pnpm fetch grab grab-dong-day 2026-07-13');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'fetch') {
    const platform = args[1];
    const accountId = args[2];
    const from = args[3] ?? new Date().toISOString().split('T')[0];
    const to = args[4] ?? from;

    if (!platform || !accountId) usage();

    // Load account from DB (not env vars — single source of truth)
    const accountRow = getAccount(accountId);
    if (!accountRow) {
      console.error(`Account not found: ${accountId}. Run seed first.`);
      process.exit(1);
    }

    if (accountRow.platform !== platform) {
      console.error(`Account ${accountId} belongs to platform '${accountRow.platform}', not '${platform}'.`);
      process.exit(1);
    }

    const range: DateRange = { from, to };
    logger.info({ platform, accountId, from, to }, 'Fetching orders');

    try {
      const orders = await runFetchJob(accountRow, range, sessionStore);

      // Revenue = completed orders only (cancelled Grab statements can still carry earnings)
      const completedOrders = orders.filter(o => o.status === 'completed');
      const totalRevenue = completedOrders.reduce((s, o) => s + o.netAmountMinor, 0);
      logger.info({ totalOrders: orders.length, completed: completedOrders.length, revenueMinor: totalRevenue }, 'Done');
      console.log(JSON.stringify({ total_orders: orders.length, completed: completedOrders.length, revenue_minor: totalRevenue }, null, 2));
    } catch (err) {
      logger.error({ err }, 'Fetch failed');
      process.exit(1);
    }
  } else if (command === 'import-session') {
    // Recovery path for needs_human: paste a session captured manually (browser devtools)
    const accountId = args[1];
    const file = args[2];
    if (!accountId || !file) usage();

    const accountRow = getAccount(accountId);
    if (!accountRow) {
      console.error(`Account not found: ${accountId}. Run seed first.`);
      process.exit(1);
    }

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
