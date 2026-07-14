#!/usr/bin/env tsx
// Composition root — registers connectors, wires up the app
import 'dotenv/config';
import { registerConnector, getConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { upsertOrders, logFetchRun, DbSessionStore, getAccount } from './db/repo.js';
import { PlatformAccount, DateRange } from './core/types.js';
import pino from 'pino';

// Register connectors at startup
registerConnector(new GrabConnector());

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'fetch') {
    const platform = args[1];
    const accountId = args[2];
    const from = args[3] ?? new Date().toISOString().split('T')[0];
    const to = args[4] ?? from;

    if (!platform || !accountId) {
      console.error('Usage: pnpm fetch <platform> <account_id> [from] [to]');
      console.error('Example: pnpm fetch grab grab-dong-day 2026-07-13');
      process.exit(1);
    }

    // Load account from DB (not env vars — single source of truth)
    const accountRow = getAccount(accountId);
    if (!accountRow) {
      console.error(`Account not found: ${accountId}. Run seed first.`);
      process.exit(1);
    }

    const connector = getConnector(platform);
    const range: DateRange = { from, to };
    const startedAt = new Date().toISOString();

    logger.info({ platform, accountId, from, to }, 'Fetching orders');

    try {
      const account: PlatformAccount = {
        id: accountRow.id,
        platform: accountRow.platform,
        merchantId: accountRow.merchantId,
        merchantName: accountRow.label,
        credentials: {
          username: process.env.GRAB_USERNAME || '',
          password: process.env.GRAB_PASSWORD || '',
        },
        timezone: accountRow.timezone,
        config: JSON.parse(accountRow.config),
      };

      const orders = await connector.fetchOrders(account, range, sessionStore);
      upsertOrders(orders);
      logFetchRun({
        platform: account.platform,
        accountId: account.id,
        dateFrom: from,
        dateTo: to,
        status: 'success',
        orderCount: orders.length,
        startedAt,
        completedAt: new Date().toISOString(),
      });

      const completed = orders.filter(o => o.status === 'completed').length;
      const totalRevenue = orders.reduce((s, o) => s + o.netAmountMinor, 0);
      logger.info({ totalOrders: orders.length, completed, revenue: totalRevenue / 1000 }, 'Done');
      console.log(JSON.stringify({ total_orders: orders.length, completed, revenue_minor: totalRevenue }, null, 2));
    } catch (err: any) {
      logFetchRun({
        platform,
        accountId,
        dateFrom: from,
        dateTo: to,
        status: 'failure',
        orderCount: 0,
        errorMessage: err.message,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      logger.error({ err }, 'Fetch failed');
      process.exit(1);
    }
  } else {
    console.error('Usage: pnpm fetch <platform> <account_id> [from] [to]');
    console.error('Example: pnpm fetch grab grab-dong-day 2026-07-14');
    process.exit(1);
  }
}

main();
