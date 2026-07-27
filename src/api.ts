// Fastify REST API — Phase 3.
// Date params are business dates (calendar days in each merchant's timezone),
// matching how revenue is reported everywhere else. Orders are stored as UTC
// instants, so we prefilter in SQL with a ±1 day margin (covers all tz offsets)
// and apply the exact per-row business-date filter in JS.
import Fastify, { FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateInTz } from './core/dates.js';
import { listFetchRuns, listOrders, OrderQuery } from './db/repo.js';

const dashboardPath = join(dirname(fileURLToPath(import.meta.url)), 'dashboard.html');

const DAY_MS = 86_400_000;
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';
const dateParam = { type: 'string', pattern: DATE_PATTERN } as const;

function utcMarginBounds(from: string, to: string) {
  return {
    fromUtc: new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS).toISOString(),
    toUtc: new Date(Date.parse(`${to}T23:59:59Z`) + DAY_MS).toISOString(),
  };
}

type OrderRow = ReturnType<typeof listOrders>[number];

function withBusinessDate(rows: OrderRow[], from: string, to: string) {
  return rows
    .map(r => ({ ...r, businessDate: dateInTz(new Date(r.orderedAt), r.platformTimezone) }))
    .filter(r => r.businessDate >= from && r.businessDate <= to);
}

export async function buildApi(logger: boolean | { transport: { target: string } } = { transport: { target: 'pino-pretty' } }) {
  const app = Fastify({ logger: logger as FastifyBaseLogger | boolean });
  await app.register(cors); // permissive default — the Phase 6 dashboard reads this API

  // ponytail: readFileSync per request — dev-refresh friendly, file is tiny; @fastify/static if assets multiply
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(readFileSync(dashboardPath, 'utf8')));

  app.get('/health', async () => ({ ok: true }));

  app.get<{ Querystring: { from: string; to: string; platform?: string; accountId?: string } }>('/summary', {
    schema: {
      querystring: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: dateParam,
          to: dateParam,
          platform: { type: 'string' },
          accountId: { type: 'string' },
        },
      },
    },
  }, async (req) => {
    const { from, to, platform, accountId } = req.query;
    const rows = withBusinessDate(
      listOrders({ ...utcMarginBounds(from, to), platform, accountId }),
      from, to,
    );

    // Group by (platform, currency) — never sum revenue across currencies
    const groups = new Map<string, { platform: string; currency: string; orders: number; completed: number; cancelled: number; revenueMinor: number }>();
    for (const r of rows) {
      const key = `${r.platform}|${r.currency}`;
      let g = groups.get(key);
      if (!g) {
        g = { platform: r.platform, currency: r.currency, orders: 0, completed: 0, cancelled: 0, revenueMinor: 0 };
        groups.set(key, g);
      }
      g.orders++;
      if (r.status === 'completed') {
        g.completed++;
        g.revenueMinor += r.netAmountMinor; // revenue = completed orders only
      }
      if (r.status === 'cancelled') g.cancelled++;
    }

    const platforms = [...groups.values()].sort((a, b) => a.platform.localeCompare(b.platform));
    const revenueByCurrency: Record<string, number> = {};
    for (const g of platforms) {
      revenueByCurrency[g.currency] = (revenueByCurrency[g.currency] ?? 0) + g.revenueMinor;
    }

    return {
      from, to,
      platforms,
      totals: {
        orders: rows.length,
        completed: platforms.reduce((s, g) => s + g.completed, 0),
        revenueByCurrency,
      },
    };
  });

  app.get<{ Querystring: { from?: string; to?: string; platform?: string; accountId?: string; status?: OrderQuery['status']; limit?: number } }>('/orders', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          from: dateParam,
          to: dateParam,
          platform: { type: 'string' },
          accountId: { type: 'string' },
          status: { type: 'string', enum: ['completed', 'cancelled', 'refunded', 'in_progress', 'other'] },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
        },
      },
    },
  }, async (req, reply) => {
    const { from, to, platform, accountId, status, limit } = req.query;
    if (!from !== !to) {
      return reply.code(400).send({ error: 'from and to must be provided together' });
    }

    if (from && to) {
      const rows = withBusinessDate(
        listOrders({ ...utcMarginBounds(from, to), platform, accountId, status }),
        from, to,
      );
      return { orders: rows.slice(0, limit) };
    }
    return { orders: listOrders({ platform, accountId, status, limit }) };
  });

  // "Did last night's fetch work?"
  app.get<{ Querystring: { limit?: number } }>('/fetch-runs', {
    schema: {
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 20 } },
      },
    },
  }, async (req) => ({ runs: listFetchRuns(req.query.limit) }));

  return app;
}

export async function startApi(port = Number(process.env.PORT ?? 3000)) {
  const app = await buildApi();
  await app.listen({ port, host: '0.0.0.0' });
  return app;
}
