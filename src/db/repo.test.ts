import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { UnifiedOrder } from '../core/types.js';
import { normalizeOrderItems } from '../platforms/grab/normalize.js';
import { GrabOrder } from '../platforms/grab/api.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const { db, upsertOrders, getOrderItems, DbSessionStore, getSessionState, markSessionNeedsHuman } = await import('./repo.js');
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
  reportDate: '2026-07-14',
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

test('needs_human lifecycle: mark without session row, recover via set()', async () => {
  const store = new DbSessionStore();
  assert.equal(getSessionState('acct-1'), null); // no session row yet

  markSessionNeedsHuman('acct-1'); // must work even when login never succeeded (no row)
  assert.equal(getSessionState('acct-1'), 'needs_human');

  markSessionNeedsHuman('acct-1'); // idempotent on existing row
  assert.equal(getSessionState('acct-1'), 'needs_human');

  await store.set('acct-1', { cookies: {}, fetchedAt: 1 }); // import-session / fresh login
  assert.equal(getSessionState('acct-1'), 'valid'); // scheduler resumes the account

  await store.remove('acct-1');
});

// ===== Order items =====
// Real v3 order-detail payloads, normalized by the shipping normalizer — the point
// is the round trip, so nothing here hand-writes an OrderItem.

const details: GrabOrder[] = JSON.parse(
  readFileSync(new URL('../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders;

const detail = (orderId: string): GrabOrder => structuredClone(
  details.find(o => o.orderID === orderId) ?? (() => { throw new Error(`fixture missing: ${orderId}`); })(),
);

/** A UnifiedOrder carrying the fixture's real lines, as the connector would build it. */
function withItems(src: GrabOrder, overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
  const { items, suspect } = normalizeOrderItems(src, src.orderID, 0);
  return { ...order, platformOrderId: src.orderID, items, itemsSuspect: suspect, ...overrides };
}

const MULTI_QTY = '001353210567-C8CYWELHLPMEEJ';     // 2 lines (one qty 2), 9 modifiers
const ITEM_DISCOUNT = '001510457039-C8C3KEBVELCJVT'; // 2 lines, 7 modifiers, 1 item discount
const FIVE_LINE = '001652323231-C8C3JTXZJGMTTJ';     // 5 lines, 15 modifiers, promo + item discount

const rowId = (platformOrderId: string) => db.select({ id: schema.orders.id })
  .from(schema.orders)
  .where(and(eq(schema.orders.platform, 'grab'), eq(schema.orders.platformOrderId, platformOrderId)))
  .get()!.id;

const itemRows = (id: number) => db.select().from(schema.orderItems)
  .where(eq(schema.orderItems.orderId, id)).orderBy(schema.orderItems.position).all();

const modifierRows = (id: number) => db.select().from(schema.orderItemModifiers)
  .where(eq(schema.orderItemModifiers.orderId, id)).all();

test('items and modifiers persist, and re-running the same fetch does not duplicate them', () => {
  // The scheduler re-fetches a trailing 2 days every night, so every order is
  // written at least twice. This is that, exactly.
  const first = upsertOrders([withItems(detail(MULTI_QTY))]);
  assert.deepEqual(first.itemFailures, []);
  assert.equal(first.itemsWritten, 1);

  const id = rowId(MULTI_QTY);
  assert.equal(itemRows(id).length, 2);
  assert.equal(modifierRows(id).length, 9);

  upsertOrders([withItems(detail(MULTI_QTY))]);

  assert.equal(itemRows(id).length, 2, 'a second identical fetch must not add lines');
  assert.equal(modifierRows(id).length, 9, 'nor modifiers');
  assert.equal(db.select().from(schema.orders).where(eq(schema.orders.id, id)).all().length, 1);
});

test('stored values match the payload, including the per-unit / per-line split', () => {
  const [line] = itemRows(rowId(MULTI_QTY));
  assert.equal(line.quantity, 2);
  assert.equal(line.unitPriceMinor, 109000);
  assert.equal(line.lineTotalMinor, 218000); // the column to sum
  assert.equal(line.baseTotalMinor, 118000);
  assert.equal(line.currency, 'VND');
  assert.equal(line.lineKey, 'VNITE2026010313490293694-a688ed2752d24ac19cec460dd8c7ba93');
});

test('items_fetched_at is stamped by the item write', () => {
  const row = db.select().from(schema.orders).where(eq(schema.orders.id, rowId(MULTI_QTY))).get()!;
  assert.notEqual(row.itemsFetchedAt, null);
});

test('an edited order that lost a line leaves no stale rows', () => {
  const id = rowId(MULTI_QTY);
  const dropped = itemRows(id)[0].lineKey;

  // What Grab actually returns after an edit: the line is gone AND the declared
  // totals are recomputed. Dropping the line alone would trip the completeness
  // guard, which is the next test.
  const edited = detail(MULTI_QTY);
  edited.itemInfo!.items!.shift();
  edited.itemInfo!.count = 1;
  edited.fare!.originalPriceInMin = 99000;
  edited.isOrderEdited = true;

  const result = upsertOrders([withItems(edited)]);
  assert.deepEqual(result.itemFailures, []);

  const items = itemRows(id);
  assert.equal(items.length, 1);
  assert.notEqual(items[0].lineKey, dropped);
  assert.equal(items[0].name, 'Sinh Tố Xoài Dừa (L)');
  // The removed line had 8 of the 9 modifiers. An upsert-on-line-key strategy
  // would have left every one of them orphaned but still queryable.
  assert.equal(modifierRows(id).length, 1);
});

test('a suspect payload never overwrites lines we already have', () => {
  const id = rowId(MULTI_QTY);
  const before = itemRows(id);

  const truncated = detail(MULTI_QTY);
  truncated.itemInfo!.items!.pop(); // totals no longer reconcile → suspect
  const suspectOrder = withItems(truncated);
  assert.ok(suspectOrder.itemsSuspect);

  const result = upsertOrders([suspectOrder]);
  assert.equal(result.itemsWritten, 0);
  assert.equal(result.itemFailures.length, 1);
  assert.match(result.itemFailures[0].error, /Refusing to overwrite stored items/);
  assert.deepEqual(itemRows(id), before, 'stored lines untouched');
});

test('a suspect payload IS stored when the order has no lines yet', () => {
  // Partial data beats none; the refusal above is only about destroying rows.
  const truncated = detail(ITEM_DISCOUNT);
  truncated.itemInfo!.items!.pop();
  const result = upsertOrders([withItems(truncated)]);

  assert.deepEqual(result.itemFailures, []);
  assert.equal(itemRows(rowId(ITEM_DISCOUNT)).length, 1);
});

test('items: undefined means "not fetched" and leaves stored lines alone', () => {
  // The detail call 500s, or the deadline hits, or the order id was not a Grab
  // order id. The order-level row still updates; the lines must survive untouched.
  const id = rowId(MULTI_QTY);
  const sentinel = '2020-01-01T00:00:00.000Z';
  db.update(schema.orders).set({ itemsFetchedAt: sentinel }).where(eq(schema.orders.id, id)).run();
  const before = itemRows(id);

  const result = upsertOrders([{
    ...order,
    platformOrderId: MULTI_QTY,
    status: 'completed',
    itemsError: 'Grab API error: HTTP 500',
  }]);

  assert.deepEqual(result.itemFailures, []);
  assert.equal(result.itemsWritten, 0);
  assert.deepEqual(itemRows(id), before);
  const row = db.select().from(schema.orders).where(eq(schema.orders.id, id)).get()!;
  assert.equal(row.status, 'completed', 'order-level data still updated');
  assert.equal(row.itemsFetchedAt, sentinel, 'a failed fetch must not blank a real timestamp');
});

test('one order failing its item write does not cost the others theirs', () => {
  // ~44 detail calls a night. A single bad payload aborting the batch would be
  // the whole point of the feature, lost.
  const doomed = detail(MULTI_QTY);
  doomed.itemInfo!.items!.pop(); // suspect, and MULTI_QTY already has stored lines

  const fresh = detail('001578008445-C8C3KBJWGYE2JN');
  const result = upsertOrders([withItems(doomed), withItems(fresh)]);

  assert.equal(result.itemFailures.length, 1);
  assert.equal(result.itemFailures[0].platformOrderId, MULTI_QTY);
  assert.equal(result.itemsWritten, 1);
  assert.equal(itemRows(rowId('001578008445-C8C3KBJWGYE2JN')).length, 2);
  assert.equal(itemRows(rowId(MULTI_QTY)).length, 1); // still the edited-order state
});

test('getOrderItems nests modifiers under their line and decodes discounts', () => {
  upsertOrders([withItems(detail(ITEM_DISCOUNT))]); // overwrite the truncated version
  const items = getOrderItems(rowId(ITEM_DISCOUNT));

  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.position), [0, 1]);
  assert.deepEqual(items.map(i => i.modifiers.length), [2, 5]);
  assert.deepEqual(items[1].modifiers.map(m => m.position), [0, 1, 2, 3, 4]);

  // discounts_json comes back as objects, not a string, and the amount is minor
  // units — 67500, not the 67.5 a naive parseFloat of '67.500' would have stored.
  assert.deepEqual(items[0].discounts, []);
  assert.equal(items[1].discounts.length, 1);
  assert.equal(items[1].discounts[0].amountMinor, 67500);
  assert.equal(items[1].discounts[0].amountDisplay, '67.500');
  assert.equal(items[1].discountMinor, 67500);
  assert.equal(items[0].discountMinor, null);
});

test('a suspect payload that IS stored is flagged on the order, and a clean one clears it', () => {
  // The truncated-200-on-a-fresh-order case. The lines get written (partial data
  // beats none) and items_fetched_at is stamped exactly as for a verified payload,
  // so without this column the rows are indistinguishable from trustworthy ones
  // forever — and the refusal gate then makes that state permanent.
  const truncated = detail(FIVE_LINE);
  truncated.itemInfo!.items!.length = 3; // a 200 carrying 3 of 5 lines
  const suspectOrder = withItems(truncated);
  assert.ok(suspectOrder.itemsSuspect);

  assert.deepEqual(upsertOrders([suspectOrder]).itemFailures, []);
  const id = rowId(FIVE_LINE);
  assert.equal(itemRows(id).length, 3);

  const flagged = db.select().from(schema.orders).where(eq(schema.orders.id, id)).get()!;
  assert.equal(flagged.itemsSuspect, suspectOrder.itemsSuspect, 'the reason reaches the database');
  assert.notEqual(flagged.itemsFetchedAt, null, 'and it is stamped like any other write');

  // The full payload the next night replaces those lines — and must retract the flag,
  // or the row stays suspect after it was fixed and the column stops meaning anything.
  assert.equal(upsertOrders([withItems(detail(FIVE_LINE))]).itemsWritten, 1);
  const cleared = db.select().from(schema.orders).where(eq(schema.orders.id, id)).get()!;
  assert.equal(cleared.itemsSuspect, null);
  assert.equal(itemRows(id).length, 5);
});

test('getOrderItems returns [] for an order whose detail was never fetched', () => {
  // [] and null are different answers at the API boundary: /orders/:id gates on
  // items_fetched_at so a never-fetched order reads null, not "no items".
  assert.deepEqual(getOrderItems(rowId('ORDER-1')), []);
});

test('getOrderItems sorts modifiers by position, whatever order the rows sit in', () => {
  // Row order is not cosmetic: the dashboard groups modifiers into consecutive
  // runs of group_id, so rows arriving out of position order would merge two
  // groups into one. Insertion order happens to match today — this pins the
  // ORDER BY that makes it a guarantee rather than a coincidence.
  const id = rowId(ITEM_DISCOUNT);
  const line = getOrderItems(id)[1];
  const stored = db.select().from(schema.orderItemModifiers)
    .where(eq(schema.orderItemModifiers.orderItemId, line.id)).all();
  assert.equal(stored.length, 5);

  // Same real rows, rewritten so rowid order now disagrees with position.
  db.delete(schema.orderItemModifiers).where(eq(schema.orderItemModifiers.orderItemId, line.id)).run();
  for (const { id: _rowid, ...m } of [...stored].reverse()) {
    db.insert(schema.orderItemModifiers).values(m).run();
  }

  const reread = getOrderItems(id)[1];
  assert.deepEqual(reread.modifiers.map(m => m.position), [0, 1, 2, 3, 4]);
  assert.deepEqual(reread.modifiers.map(m => m.name), line.modifiers.map(m => m.name));
});
