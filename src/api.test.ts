import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedOrder } from './core/types.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-api-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const { db, upsertOrders, logFetchRun } = await import('./db/repo.js');
const { runMigrations } = await import('./db/migrate.js');
const schema = await import('./db/schema.js');
const { buildApi } = await import('./api.js');

runMigrations();

db.insert(schema.merchants).values({ id: 'merch-1', name: 'Test Merchant' }).run();
db.insert(schema.platformAccounts).values([
  { id: 'acct-1', merchantId: 'merch-1', platform: 'grab', label: 'grab acct', credentialKey: 'k' },
  { id: 'acct-2', merchantId: 'merch-1', platform: 'foodpanda', label: 'fp acct', credentialKey: 'k' },
]).run();

const base: Omit<UnifiedOrder, 'platformOrderId' | 'status' | 'platformStatus' | 'netAmountMinor' | 'orderedAt'> = {
  platform: 'grab',
  accountId: 'acct-1',
  merchantId: 'merch-1',
  grossAmountMinor: null,
  currency: 'VND',
  platformTimezone: 'Asia/Ho_Chi_Minh',
  updatedAt: '2026-07-14T08:00:00Z',
  rawJson: {},
};

upsertOrders([
  // 18:30 UTC = 01:30 next day in UTC+7 → business date 2026-07-14, NOT 07-13
  { ...base, platformOrderId: 'A', status: 'completed', platformStatus: 'COMPLETED', netAmountMinor: 100_000, orderedAt: '2026-07-13T18:30:00Z' },
  { ...base, platformOrderId: 'B', status: 'cancelled', platformStatus: 'CANCELLED', netAmountMinor: 50_000, orderedAt: '2026-07-14T03:00:00Z' },
  { ...base, platform: 'foodpanda', accountId: 'acct-2', platformOrderId: 'C', status: 'completed', platformStatus: 'DONE', netAmountMinor: 200_000, orderedAt: '2026-07-14T05:00:00Z' },
]);

const app = await buildApi(false);

after(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('GET /health', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('GET /summary aggregates cross-platform on business dates (merchant tz)', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-14&to=2026-07-14' });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.deepEqual(body.totals, { orders: 3, completed: 2, revenueByCurrency: { VND: 300_000 } });
  assert.deepEqual(body.platforms, [
    { platform: 'foodpanda', currency: 'VND', orders: 1, completed: 1, cancelled: 0, revenueMinor: 200_000 },
    // revenue counts completed only — cancelled B's 50k excluded
    { platform: 'grab', currency: 'VND', orders: 2, completed: 1, cancelled: 1, revenueMinor: 100_000 },
  ]);
});

test('GET /summary: order at 18:30Z belongs to the NEXT local day, not the UTC day', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-13&to=2026-07-13' });
  assert.equal(res.json().totals.orders, 0);
});

test('GET /summary requires from/to', async () => {
  const res = await app.inject({ method: 'GET', url: '/summary?from=2026-07-14' });
  assert.equal(res.statusCode, 400);
});

test('GET /orders filters by status and annotates businessDate', async () => {
  const res = await app.inject({ method: 'GET', url: '/orders?from=2026-07-14&to=2026-07-14&status=completed' });
  assert.equal(res.statusCode, 200);
  const { orders } = res.json();
  assert.equal(orders.length, 2);
  assert.ok(orders.every((o: any) => o.status === 'completed' && o.businessDate === '2026-07-14'));
  assert.ok(orders.every((o: any) => !('rawJson' in o)));
});

test('GET /orders without range returns newest first with limit', async () => {
  const res = await app.inject({ method: 'GET', url: '/orders?limit=1' });
  const { orders } = res.json();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].platformOrderId, 'C');
});

test('GET /orders rejects from without to', async () => {
  const res = await app.inject({ method: 'GET', url: '/orders?from=2026-07-14' });
  assert.equal(res.statusCode, 400);
});

test('GET /fetch-runs returns logged runs', async () => {
  logFetchRun({
    platform: 'grab', accountId: 'acct-1',
    dateFrom: '2026-07-14', dateTo: '2026-07-14',
    status: 'success', orderCount: 3,
    startedAt: '2026-07-14T06:30:00Z', completedAt: '2026-07-14T06:31:00Z',
  });
  const res = await app.inject({ method: 'GET', url: '/fetch-runs' });
  const { runs } = res.json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'success');
  assert.equal(runs[0].orderCount, 3);
});
