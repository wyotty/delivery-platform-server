// Server entry (pnpm start) — composition root for the long-running process.
import 'dotenv/config';
import pino from 'pino';
import { registerConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { runMigrations } from './db/migrate.js';
import { runAllAccounts, startScheduler } from './scheduler.js';
import { startApi } from './api.js';

const logger = pino({ transport: { target: 'pino-pretty' } });

registerConnector(new GrabConnector());
runMigrations();
startScheduler();
await startApi().catch(err => {
  logger.error({ err }, 'API failed to start');
  process.exit(1);
});
logger.info('Server up — scheduler armed, API listening');

// Fetch immediately on boot (useful after deploys/downtime), then daily per cron
if (process.env.RUN_ON_START === '1') {
  void runAllAccounts();
}
