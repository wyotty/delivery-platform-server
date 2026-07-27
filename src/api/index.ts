import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Logger } from 'pino';
import { z } from 'zod';
import { Config } from '../config/index.js';
import { SessionStore } from '../core/types.js';
import { buildAccount, fetchAndStore } from '../core/fetch-service.js';
import { getSessionState, getSummary, listAccounts, listFetchRuns, listOrders } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const RangeQuery = z.object({
  from: DATE,
  to: DATE,
  merchantId: z.string().optional(),
  platform: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const BackfillBody = z.object({
  accountId: z.string(),
  from: DATE,
  to: DATE,
});

// Return type is inferred on purpose: passing a pino instance specialises
// FastifyInstance over pino's Logger, which the default generic doesn't match.
export function buildApi(
  config: Config,
  sessionStore: SessionStore,
  logger: Logger,
  notifier?: Notifier,
) {
  const app = Fastify({ loggerInstance: logger });
  void app.register(cors, { origin: true });

  app.get('/health', async () => ({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()) }));

  app.get('/accounts', async () =>
    listAccounts().map(a => ({
      id: a.id,
      platform: a.platform,
      merchantId: a.merchantId,
      label: a.label,
      timezone: a.timezone,
      sessionState: getSessionState(a.id),
    })),
  );

  /**
   * Cross-platform totals. Buckets by the platform's own business day
   * (report_date), so these figures reconcile with the merchant portal —
   * grouping by ordered_at would not.
   */
  app.get('/summary', async (request, reply) => {
    const parsed = RangeQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const { from, to, merchantId } = parsed.data;
    if (from > to) return reply.code(400).send({ error: `from (${from}) is after to (${to})` });

    const rows = getSummary({ from, to, merchantId });
    return {
      range: { from, to },
      byDay: rows,
      totals: rows.reduce<Record<string, { orderCount: number; completedCount: number; revenueMinor: number }>>(
        (acc, r) => {
          const bucket = (acc[r.currency] ??= { orderCount: 0, completedCount: 0, revenueMinor: 0 });
          bucket.orderCount += r.orderCount;
          bucket.completedCount += r.completedCount;
          bucket.revenueMinor += r.revenueMinor;
          return acc;
        },
        {},
      ),
    };
  });

  app.get('/orders', async (request, reply) => {
    const parsed = RangeQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const { from, to, merchantId, platform, limit } = parsed.data;
    if (from > to) return reply.code(400).send({ error: `from (${from}) is after to (${to})` });

    const orders = listOrders({ from, to, merchantId, platform, limit });
    return { range: { from, to }, count: orders.length, orders };
  });

  app.get('/runs', async () => ({ runs: listFetchRuns() }));

  /** Manual backfill — the recovery path when a nightly fetch failed. */
  app.post('/fetch', async (request, reply) => {
    const parsed = BackfillBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const { accountId, from, to } = parsed.data;
    if (from > to) return reply.code(400).send({ error: `from (${from}) is after to (${to})` });

    try {
      const account = buildAccount(accountId);
      const result = await fetchAndStore(account, { from, to }, sessionStore, logger, notifier);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  return app;
}
