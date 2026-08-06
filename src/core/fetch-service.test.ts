import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desc } from 'drizzle-orm';
import pino from 'pino';
import {
  AuthError, DateRange, PlatformAccount, PlatformConnector, SessionStore, UnifiedOrder,
  attachPartialOrders,
} from './types.js';
import { registerConnector } from './registry.js';
import { normalizeOrderItems } from '../platforms/grab/normalize.js';
import { GrabOrder } from '../platforms/grab/api.js';
import type { Notifier } from '../notify/index.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-fetch-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const { db } = await import('../db/repo.js');
const { runMigrations } = await import('../db/migrate.js');
const schema = await import('../db/schema.js');
const { buildAccount, fetchAndStore } = await import('./fetch-service.js');

runMigrations();
db.insert(schema.merchants).values({ id: 'merch-1', name: 'Test Merchant' }).run();
db.insert(schema.platformAccounts).values({
  id: 'acct-1', merchantId: 'merch-1', platform: 'grab', label: 'test', credentialKey: 'k',
}).run();

after(() => rmSync(tmp, { recursive: true, force: true }));

const logger = pino({ level: 'silent' });
const range: DateRange = { from: '2026-07-26', to: '2026-07-26' };

class CollectingNotifier implements Notifier {
  readonly enabled = true;
  alerts: string[] = [];
  async alert(message: string) { this.alerts.push(message); }
}

const store: SessionStore = {
  async get() { return null; },
  async set() {},
  async remove() {},
};

/** Returns whatever the test stages, so fetchAndStore's real persistence path runs. */
let staged: () => Promise<UnifiedOrder[]> = async () => [];
const fake: PlatformConnector = {
  platform: 'grab',
  fetchOrders: () => staged(),
  checkAuth: async () => 'valid',
};
registerConnector(fake);

const account: PlatformAccount = buildAccount('acct-1');

// Real v3 payloads — nothing here hand-writes an OrderItem.
const details: GrabOrder[] = JSON.parse(
  readFileSync(new URL('../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders;
const detail = (orderId: string): GrabOrder => structuredClone(
  details.find(o => o.orderID === orderId) ?? (() => { throw new Error(`fixture missing: ${orderId}`); })(),
);

const ORDER_ID = '001652323231-C8C3JTXZJGMTTJ'; // 5 lines, 15 modifiers

function order(src: GrabOrder, overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
  const { items, suspect } = normalizeOrderItems(src, src.orderID, 0);
  return {
    platform: 'grab',
    platformOrderId: src.orderID,
    accountId: 'acct-1',
    merchantId: 'merch-1',
    status: 'completed',
    platformStatus: 'COMPLETED',
    grossAmountMinor: null,
    netAmountMinor: 500_000,
    currency: 'VND',
    orderedAt: '2026-07-26T10:00:00Z',
    reportDate: '2026-07-26',
    platformTimezone: 'Asia/Ho_Chi_Minh',
    updatedAt: '2026-07-26T11:00:00Z',
    rawJson: { ID: src.orderID },
    items,
    itemsSuspect: suspect,
    ...overrides,
  };
}

const lastRun = () => db.select().from(schema.fetchRuns).orderBy(desc(schema.fetchRuns.id)).get()!;

test('a clean run is a success', async () => {
  staged = async () => [order(detail(ORDER_ID))];
  const notifier = new CollectingNotifier();
  const result = await fetchAndStore(account, range, store, logger, notifier);

  assert.equal(result.itemsWritten, 1);
  assert.equal(result.itemFailures, 0);
  assert.equal(result.itemsMissing, 0);
  assert.equal(lastRun().status, 'success');
  assert.equal(lastRun().errorMessage, null);
  assert.deepEqual(notifier.alerts, []);
});

test('a refused line-item write makes the run partial, logged and alerted', async () => {
  // Grab starts returning truncated detail payloads. normalizeOrderItems flags the
  // payload suspect, replaceOrderItems refuses the destructive overwrite of the
  // lines stored above — and the run used to be recorded 'success' with the full
  // order count anyway, no log line and no run-level record, so the lines stayed
  // frozen night after night with items_fetched_at as the only (unqueried) tell.
  const truncated = detail(ORDER_ID);
  truncated.itemInfo!.items!.length = 3;
  staged = async () => [order(truncated)];

  const notifier = new CollectingNotifier();
  const result = await fetchAndStore(account, range, store, logger, notifier);

  assert.equal(result.totalOrders, 1, 'the order-level row still lands');
  assert.equal(result.itemFailures, 1);
  assert.equal(result.itemsWritten, 0);

  const run = lastRun();
  assert.equal(run.status, 'partial');
  assert.equal(run.orderCount, 1);
  assert.match(run.errorMessage ?? '', /line items could not be written/);
  assert.match(run.errorMessage ?? '', new RegExp(ORDER_ID));
  assert.match(run.errorMessage ?? '', /Refusing to overwrite stored items/);

  assert.equal(notifier.alerts.length, 1, 'a permanently frozen line-item table has to page someone');
  assert.match(notifier.alerts[0], new RegExp(ORDER_ID));

  // And the stored lines are genuinely untouched — that refusal is the point.
  const row = db.select().from(schema.orders).get()!;
  assert.equal(db.select().from(schema.orderItems).all().filter(i => i.orderId === row.id).length, 5);
});

test('an order whose detail call failed makes the run partial, without an alert', async () => {
  // HTTP 500, the deadline, a booking-code-only statement. Tomorrow's trailing
  // re-fetch retries it, so this is recorded but not paged.
  staged = async () => [order(detail(ORDER_ID), { items: undefined, itemsError: 'Grab API error: HTTP 500' })];

  const notifier = new CollectingNotifier();
  const result = await fetchAndStore(account, range, store, logger, notifier);

  assert.equal(result.itemsMissing, 1);
  assert.equal(result.itemFailures, 0);
  assert.equal(lastRun().status, 'partial');
  assert.match(lastRun().errorMessage ?? '', /no item detail.*HTTP 500/);
  assert.deepEqual(notifier.alerts, []);
});

test('an aborted run still stores its salvaged orders and records the failure', async () => {
  staged = async () => {
    throw attachPartialOrders(
      new AuthError('expired', 'Grab session expired again after re-login'),
      [order(detail('001578008445-C8C3KBJWGYE2JN'))],
    );
  };

  const notifier = new CollectingNotifier();
  await assert.rejects(() => fetchAndStore(account, range, store, logger, notifier), AuthError);

  const run = lastRun();
  assert.equal(run.status, 'failure');
  assert.equal(run.orderCount, 1, 'the salvaged order counts — it really was stored');
  assert.equal(db.select().from(schema.platformSessions).get()?.state, 'expired');
  assert.match(notifier.alerts[0], /auth expired/);
});
