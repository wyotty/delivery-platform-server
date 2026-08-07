import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { UnifiedOrder } from '../core/types.js';
import { GrabOrder } from '../platforms/grab/api.js';
import { normalizeOrderFare, normalizeOrderItems } from '../platforms/grab/normalize.js';
import { parseJsonLossless } from '../core/json.js';

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

// A real captured v3 detail payload, normalized exactly as the connector does, so
// /orders/:id is exercised against the shape it actually serves. Parked on its own
// report_date so it cannot move the summary figures the tests below assert on.
const detail: GrabOrder = JSON.parse(
  readFileSync(new URL('../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders.find((o: GrabOrder) => o.orderID === '001652323231-C8C3JTXZJGMTTJ');

// Grab's own int64 bitfield, off a live response for 001008233253-C8C3AP61CEDHCJ.
// It sits 131 away from the nearest double, so it is the whole test: any parse and
// re-serialize on this path turns it into 4035792627008805000 on the way out.
const ORDER_FLAGS = '4035792627008804869';

// The response body as Grab sends it — the `{"order":{…}}` envelope, and a string,
// because that is what the connector hands over and what the column stores. The
// committed fixture went through a JSON.parse of its own, so its orderFlags is
// already the rounded double: drop it and splice in the literal off the wire.
const { orderFlags: _rounded, ...detailFields } = detail;
const detailBody = `{"order":{"orderFlags":${ORDER_FLAGS},${JSON.stringify(detailFields).slice(1)}}`;

// The daily statement has an int64 of its own — a DIFFERENT one, off a live report
// for 001578008445-C8C3KBJWGYE2JN — and the dialog renders it a few lines from the
// detail payload. Parsed the way fetchDailyReport hands it over, because raw_json
// is re-serialized from this object rather than stored as a body.
const STATEMENT_FLAGS = '4035788216077387780';
const statement = (parseJsonLossless(
  `{"statements":[{"ID":"${detail.orderID}","orderFlags":${STATEMENT_FLAGS},"deliveryStatus":"COMPLETED"}]}`,
) as { statements: unknown[] }).statements[0];

const detailed: UnifiedOrder = {
  ...base,
  platformOrderId: detail.orderID,
  orderedAt: '2026-07-28T10:00:00Z',
  reportDate: '2026-07-28',
  rawJson: statement,
  items: normalizeOrderItems(detail, detail.orderID, 0).items,
  detailRawJson: detailBody,
  fare: normalizeOrderFare(detail, 0),
};

upsertOrders([
  base,
  detailed,
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

test('GET /orders/:id hands back both raw payloads decoded, and the fare in minor units', async () => {
  const list = await app.inject({ method: 'GET', url: '/orders?from=2026-07-28&to=2026-07-28' });
  assert.equal(list.json().count, 1);
  const res = await app.inject({ method: 'GET', url: `/orders/${list.json().orders[0].id}` });
  assert.equal(res.statusCode, 200);
  const order = res.json();

  // Objects, never JSON strings: no caller should have to double-parse, and the
  // dashboard renders them without knowing they were ever text. The whole envelope,
  // so a key Grab adds beside `order` is served too rather than quietly dropped.
  assert.equal(typeof order.detailRawJson, 'object');
  assert.deepEqual(Object.keys(order.detailRawJson), ['order']);
  const { orderFlags: _served, ...servedOrder } = order.detailRawJson.order;
  assert.deepEqual(servedOrder, detailFields);
  assert.equal(order.items.length, 5);
  assert.deepEqual(order.items.map((i: { rawJson: unknown }) => i.rawJson), detail.itemInfo!.items);
  assert.equal(typeof order.items[0].rawJson, 'object');
  // Nothing is scrubbed on the way out any more than on the way in — the fields
  // the columns ignore are the whole reason the payload is stored.
  for (const key of ['eater', 'driver', 'times', 'paymentMethod', 'orderChangeLog']) {
    assert.ok(key in order.detailRawJson.order, key);
  }

  // The bytes Fastify wrote, not res.json(): the client's own JSON.parse rounds this
  // field, so parsing the response before checking it would assert nothing. An
  // int64 that reached the database intact and then got rounded on the way out is
  // still a wrong number in front of whoever asked for it.
  //
  // BOTH raw payloads, because the dialog shows them a few lines apart and each has
  // its own orderFlags: the detail body, and the daily statement in rawJson, which
  // reaches this response through a JSON.parse of the column.
  assert.match(res.body, new RegExp(`"orderFlags":${ORDER_FLAGS}[,}]`));
  assert.match(res.body, new RegExp(`"orderFlags":${STATEMENT_FLAGS}[,}]`));
  assert.doesNotMatch(res.body, /4035788216077388000|4035792627008805000/, 'no rounded double anywhere');
  assert.equal(order.rawJson.ID, detail.orderID, 'and the statement is still an object with readable fields');

  // fare_* arrive already parsed: '32.000' is 32000 đồng, and re-deriving that
  // client-side is exactly the 1000x bug money.ts exists to prevent.
  assert.equal(order.fareDeliveryFeeMinor, 32000);
  assert.equal(order.farePassengerTotalMinor, 580000);
  assert.equal(order.fareCommissionMinor, 134466);
  assert.equal(order.fareTaxMinor, 0);                  // a real zero
  assert.equal(order.farePromotionMinor, null);         // Grab's '-' sentinel
  assert.equal(order.farePromotionDisplay, '-');        // …still tellable apart
  assert.equal(order.fareMerchantChargeMinor, null);
  assert.equal(order.fareMerchantChargeDisplay, '');
});

test('GET /orders/:id still serves an order whose detail was never fetched', async () => {
  const list = await app.inject({ method: 'GET', url: '/orders?from=2026-07-27&to=2026-07-27' });
  const res = await app.inject({ method: 'GET', url: `/orders/${list.json().orders[0].id}` });
  assert.equal(res.statusCode, 200);
  const order = res.json();

  assert.equal(order.platformOrderId, 'ORDER-4');
  // null, not an absent key and not {}: the caller has to be able to tell "never
  // fetched" from "fetched and empty", the same distinction items already carries.
  assert.ok('detailRawJson' in order, 'detailRawJson must be present, not an absent key');
  assert.equal(order.detailRawJson, null);
  assert.equal(order.rejectedDetailRawJson, null);
  assert.equal(order.items, null);
  assert.equal(order.itemsFetchedAt, null);
  for (const [k, v] of Object.entries(order)) {
    if (k.startsWith('fare')) assert.equal(v, null, k);
  }
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
