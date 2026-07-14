import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnifiedOrder } from '../core/types.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const { db, upsertOrders, DbSessionStore } = await import('./repo.js');
const { runMigrations } = await import('./migrate.js');
const schema = await import('./schema.js');

runMigrations();

// Satisfy FK constraints on orders/sessions
db.insert(schema.merchants).values({ id: 'merch-1', name: 'Test Merchant' }).run();
db.insert(schema.platformAccounts).values({
  id: 'acct-1', merchantId: 'merch-1', platform: 'grab', label: 'test', credentialKey: 'k',
}).run();

after(() => rmSync(tmp, { recursive: true, force: true }));

const order: UnifiedOrder = {
  platform: 'grab',
  platformOrderId: 'ORDER-1',
  accountId: 'acct-1',
  merchantId: 'merch-1',
  status: 'in_progress',
  platformStatus: 'ORDER_EXECUTING',
  grossAmountMinor: null,
  netAmountMinor: 312000,
  currency: 'VND',
  orderedAt: '2026-07-14T06:22:29Z',
  platformTimezone: 'Asia/Ho_Chi_Minh',
  updatedAt: '2026-07-14T06:40:13Z',
  rawJson: { ID: 'ORDER-1' },
};

test('upsertOrders inserts then updates on same (platform, platformOrderId)', () => {
  upsertOrders([order]);
  upsertOrders([{ ...order, status: 'completed', platformStatus: 'COMPLETED', netAmountMinor: 300000, updatedAt: '2026-07-14T07:00:00Z' }]);

  const rows = db.select().from(schema.orders).all();
  assert.equal(rows.length, 1); // updated, not duplicated
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].netAmountMinor, 300000);
  assert.equal(rows[0].grossAmountMinor, null);
  assert.equal(rows[0].updatedAt, '2026-07-14T07:00:00Z');
});

test('same platformOrderId on a different platform is a separate row', () => {
  upsertOrders([{ ...order, platform: 'foodpanda' }]);
  const rows = db.select().from(schema.orders).all();
  assert.equal(rows.length, 2);
});

test('DbSessionStore round-trips, overwrites, and removes', async () => {
  const store = new DbSessionStore();
  assert.equal(await store.get('acct-1'), null);

  const session = { cookies: { a: '1' }, fetchedAt: 1234567890 };
  await store.set('acct-1', session);
  assert.deepEqual(await store.get('acct-1'), session);

  const session2 = { cookies: { a: '2' }, fetchedAt: 1234567999 };
  await store.set('acct-1', session2); // upsert, not duplicate PK error
  assert.deepEqual(await store.get('acct-1'), session2);

  await store.remove('acct-1');
  assert.equal(await store.get('acct-1'), null);
});
