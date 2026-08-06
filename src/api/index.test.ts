import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { UnifiedOrder } from '../core/types.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-api-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const { db, upsertOrders, DbSessionStore } = await import('../db/repo.js');
const { runMigrations } = await import('../db/migrate.js');
const schema = await import('../db/schema.js');
const { buildApi } = await import('./index.js');
const { loadConfig } = await import('../config/index.js');

runMigrations();

db.insert(schema.merchants).values({ id: 'merch-1', name: 'Test Merchant' }).run();
db.insert(schema.platformAccounts).values({
  id: 'acct-1', merchantId: 'merch-1', platform: 'grab', label: 'test', credentialKey: 'k',
}).run();

const base: UnifiedOrder = {
  platform: 'grab',
  platformOrderId: 'ORDER-1',
  accountId: 'acct-1',
  merchantId: 'merch-1',
  status: 'completed',
  platformStatus: 'COMPLETED',
  grossAmountMinor: null,
  netAmountMinor: 100_000,
  currency: 'VND',
  orderedAt: '2026-07-26T10:00:00Z',
  reportDate: '2026-07-26',
  platformTimezone: 'Asia/Ho_Chi_Minh',
  updatedAt: '2026-07-26T11:00:00Z',
  rawJson: {},
};

upsertOrders([
  base,
  // The cross-midnight case: placed late on 07-25 local time, but Grab reports it
  // under 07-26. It must be counted on 07-26, not on the day it was placed.
  { ...base, platformOrderId: 'ORDER-2', orderedAt: '2026-07-25T15:17:24Z', reportDate: '2026-07-26', netAmountMinor: 50_000 },
  // A cancelled order still carries earnings — must not be counted as revenue.
  { ...base, platformOrderId: 'ORDER-3', status: 'cancelled', platformStatus: 'CANCELLED', netAmountMinor: 999_000 },
  { ...base, platformOrderId: 'ORDER-4', reportDate: '2026-07-27', netAmountMinor: 70_000 },
]);

const app = buildApi(
  loadConfig({} as NodeJS.ProcessEnv),
  new DbSessionStore(),
  pino({ level: 'silent' }),
);

after(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('GET /health reports ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('GET /summary buckets by report_date, not by ordered_at', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-26&to=2026-07-26' });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.byDay.length, 1);
  assert.equal(body.byDay[0].reportDate, '2026-07-26');
  // 3 orders carry report_date 07-26 even though ORDER-2 was placed on 07-25.
  assert.equal(body.byDay[0].orderCount, 3);
  assert.equal(body.byDay[0].completedCount, 2);
  // Revenue excludes the cancelled order's 999_000.
  assert.equal(body.byDay[0].revenueMinor, 150_000);
});

test('GET / serves the dashboard', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.match(res.body, /Delivery ops/);
});

test('GET /summary rolls up per platform, counting cancelled separately from revenue', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-26&to=2026-07-27' });
  assert.deepEqual(res.json().platforms, [
    // ORDER-3 is cancelled: counted in orders and cancelled, excluded from revenue.
    { platform: 'grab', currency: 'VND', orders: 4, completed: 3, cancelled: 1, revenueMinor: 220_000 },
  ]);
});

test('GET /summary totals aggregate per currency across the range', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-26&to=2026-07-27' });
  const body = res.json();
  assert.equal(body.byDay.length, 2);
  assert.equal(body.totals.VND.revenueMinor, 220_000);
  assert.equal(body.totals.VND.orderCount, 4);
});

test('GET /summary rejects a malformed date', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-7-26&to=2026-07-26' });
  assert.equal(res.statusCode, 400);
});

test('GET /summary rejects a reversed range instead of silently returning nothing', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-27&to=2026-07-26' });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /is after/);
});

test('GET /orders filters by report_date range and platform', async () => {
  const res = await app.inject({ method: 'GET', url: '/orders?from=2026-07-27&to=2026-07-27&platform=grab' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().count, 1);
  assert.equal(res.json().orders[0].platformOrderId, 'ORDER-4');
});

test('GET /orders returns nothing for a platform that has no rows', async () => {
  const res = await app.inject({ method: 'GET', url: '/orders?from=2026-07-26&to=2026-07-27&platform=foodpanda' });
  assert.equal(res.json().count, 0);
});

test('GET /orders/:id returns the full order with parsed rawJson; 404 when missing', async () => {
  const list = await app.inject({ method: 'GET', url: '/orders?from=2026-07-27&to=2026-07-27' });
  const id = list.json().orders[0].id;

  const res = await app.inject({ method: 'GET', url: `/orders/${id}` });
  assert.equal(res.statusCode, 200);
  const order = res.json();
  assert.equal(order.id, id);
  assert.equal(order.platformOrderId, 'ORDER-4');
  assert.deepEqual(order.rawJson, {}); // parsed object, not a JSON string
  // Present even when null: it is how a caller tells lines from a payload that
  // failed its completeness checks apart from verified ones, so it can never be
  // an absent key that reads as "fine".
  assert.ok('itemsSuspect' in order);
  assert.equal(order.itemsSuspect, null);

  assert.equal((await app.inject({ method: 'GET', url: '/orders/999999' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/orders/abc' })).statusCode, 400);
});

test('GET /accounts exposes the session state used for needs_human alerting', async () => {
  const res = await app.inject({ method: 'GET', url: '/accounts' });
  assert.equal(res.statusCode, 200);
  const accounts = res.json();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].id, 'acct-1');
  // No session row has been written yet, so there is no state to report.
  assert.equal(accounts[0].sessionState, null);
});

test('POST /fetch validates its body', async () => {
  const res = await app.inject({ method: 'POST', url: '/fetch', payload: { accountId: 'acct-1', from: 'nope', to: '2026-07-26' } });
  assert.equal(res.statusCode, 400);
});
