// Composition root for the long-running server: registers connectors, wires the
// API, the scheduler and the notifier, then blocks until shut down.
import pino from 'pino';
import { loadConfig } from './config/index.js';
import { registerConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { DbSessionStore } from './db/repo.js';
import { runMigrations } from './db/migrate.js';
import { buildApi } from './api/index.js';
import { runDailyFetch, startScheduler } from './scheduler/index.js';
import { createNotifier } from './notify/index.js';

const config = loadConfig();

const logger = pino({
  level: config.logLevel,
  transport: process.stdout.isTTY ? { target: 'pino-pretty' } : undefined,
});

// Connectors are registered here, not inside the registry — the registry must not
// depend on the platform adapters it serves.
registerConnector(new GrabConnector());

const sessionStore = new DbSessionStore();
const notifier = createNotifier(config, logger);

async function main() {
  // Migrate on boot so a fresh container is usable without a manual step.
  runMigrations();
  logger.info('Migrations applied');

  const app = buildApi(config, sessionStore, logger, notifier);
  await app.listen({ host: config.host, port: config.port });
  logger.info({ host: config.host, port: config.port }, 'API listening');

  const task = startScheduler(config, sessionStore, logger, notifier);

  if (config.fetchOnBoot) {
    logger.info('FETCH_ON_BOOT set — running the daily fetch immediately');
    void runDailyFetch(config, sessionStore, logger, notifier).catch(err =>
      logger.error({ err }, 'Boot fetch failed'),
    );
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await task.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(err => {
  logger.error({ err }, 'Fatal');
  process.exit(1);
});
