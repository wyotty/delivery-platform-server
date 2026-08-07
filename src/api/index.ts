import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { z } from 'zod';
import { Config } from '../config/index.js';
import { SessionStore } from '../core/types.js';
import { parseJsonLossless } from '../core/json.js';
import { buildAccount, fetchAndStore } from '../core/fetch-service.js';
import { getOrder, getOrderItems, getSessionState, getSummary, listAccounts, listFetchRuns, listOrders } from '../db/repo.js';
import type { Notifier } from '../notify/index.js';

const dashboardPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.html');

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

  // ponytail: readFileSync per request — dev-refresh friendly, file is tiny; @fastify/static if assets multiply
  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(readFileSync(dashboardPath, 'utf8')),
  );

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

    // Rolled up per (platform, currency) across the range — never sum revenue
    // across currencies. This is what the dashboard's platform table renders.
    const platforms = new Map<string, { platform: string; currency: string; orders: number; completed: number; cancelled: number; revenueMinor: number }>();
    for (const r of rows) {
      const key = `${r.platform}|${r.currency}`;
      const p = platforms.get(key) ?? { platform: r.platform, currency: r.currency, orders: 0, completed: 0, cancelled: 0, revenueMinor: 0 };
      p.orders += r.orderCount;
      p.completed += r.completedCount;
      p.cancelled += r.cancelledCount;
      p.revenueMinor += r.revenueMinor;
      platforms.set(key, p);
    }

    return {
      range: { from, to },
      byDay: rows,
      platforms: [...platforms.values()].sort((a, b) => a.platform.localeCompare(b.platform)),
      totals: rows.reduce<Record<string, { orderCount: number; completedCount: number; cancelledCount: number; revenueMinor: number }>>(
        (acc, r) => {
          const bucket = (acc[r.currency] ??= { orderCount: 0, completedCount: 0, cancelledCount: 0, revenueMinor: 0 });
          bucket.orderCount += r.orderCount;
          bucket.completedCount += r.completedCount;
          bucket.cancelledCount += r.cancelledCount;
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

  /** Full order including the raw platform payload and its lines — the dashboard's detail view. */
  app.get('/orders/:id', async (request, reply) => {
    const parsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: z.treeifyError(parsed.error) });

    const row = getOrder(parsed.data.id);
    if (!row) return reply.code(404).send({ error: 'Order not found' });
    return {
      // ...row carries the fare_* columns as-is: they are already integers in minor
      // units, and re-deriving them client-side is what money.ts exists to prevent.
      ...row,
      // parseJsonLossless, not JSON.parse, on every raw column: they hold Grab's
      // int64 orderFlags intact — the daily statement carries one of its own, not
      // just the detail payload — and a plain parse here would round it back out on
      // the way to the client, a right answer in the database that nobody can read.
      rawJson: parseJsonLossless(row.rawJson),
      // Objects, not strings. Both raw payloads are handed back decoded so a caller
      // never has to double-parse — and so the dashboard can render them without
      // knowing they were ever text. null = detail never fetched, same as itemsFetchedAt.
      detailRawJson: row.detailRawJson ? parseJsonLossless(row.detailRawJson) : null,
      // The payload of a refused suspect re-fetch, decoded the same way. Present
      // only while this order's stored lines are frozen — see schema.ts.
      rejectedDetailRawJson: row.rejectedDetailRawJson ? parseJsonLossless(row.rejectedDetailRawJson) : null,
      // `null` and `[]` are different answers and callers must be able to tell them
      // apart: null = the detail call has never succeeded for this order, [] = it did
      // and the platform reported no lines. itemsFetchedAt (already in ...row) says when.
      // Each item's own rawJson is decoded by getOrderItems for the same reason.
      items: row.itemsFetchedAt ? getOrderItems(row.id) : null,
    };
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
