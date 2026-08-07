import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { UnifiedOrder } from '../core/types.js';
import { parseJsonLossless } from '../core/json.js';
import { normalizeOrder, normalizeOrderFare, normalizeOrderItems } from '../platforms/grab/normalize.js';
import { GrabOrder, GrabStatement } from '../platforms/grab/api.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-test-'));
process.env.DB_PATH = join(tmp, 'test.db');

const {
  db, upsertOrders, getOrderItems, getStoredOrderDetail,
  DbSessionStore, getSessionState, markSessionNeedsHuman,
} = await import('./repo.js');
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

/**
 * The response body for a fixture, as Grab would have sent it: the `{"order":{…}}`
 * envelope, undecoded. detailRawJson is a string end to end — the connector reads
 * resp.text() and nothing re-serializes it, which is the only way the payload
 * stored is the payload received.
 */
const body = (src: GrabOrder) => JSON.stringify({ order: src });

/** A UnifiedOrder carrying the fixture's real lines, as the connector would build it. */
function withItems(src: GrabOrder, overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
  const { items, suspect } = normalizeOrderItems(src, src.orderID, 0);
  // items, detailRawJson and fare are set together by the connector — only after
  // the payload has been vetted — and written in one statement by replaceOrderItems.
  // Building them together here is what makes these tests exercise that unit.
  return {
    ...order,
    platformOrderId: src.orderID,
    items,
    itemsSuspect: suspect,
    detailRawJson: body(src),
    fare: normalizeOrderFare(src, 0),
    ...overrides,
  };
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
  //
  // subTotalDisplay is the figure that moves, verified against the one live order
  // this account has with isOrderEdited true (001401453-C8CHR7BTRLLBWE): its
  // subTotalDisplay follows the edited lines exactly, while originalPriceInMin
  // stays on the pre-edit basis and ends up BELOW them. Which is why the gate
  // reconciles against the subtotal — see normalizeOrderItems.
  const edited = detail(MULTI_QTY);
  edited.itemInfo!.items!.shift();
  edited.itemInfo!.count = 1;
  edited.fare!.subTotalDisplay = '99.000';
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

// ===== Raw payloads and the fare breakdown =====
// The columns exist so a question nobody anticipated is a query rather than a
// re-fetch of history Grab will not serve twice. Each test below re-stores the
// order it inspects, so it does not depend on what the tests above left behind.

const orderRow = (platformOrderId: string) =>
  db.select().from(schema.orders).where(eq(schema.orders.id, rowId(platformOrderId))).get()!;

test('the detail payload round-trips byte-identical through store → read', () => {
  const src = detail(FIVE_LINE);
  const sent = body(src);
  upsertOrders([withItems(src)]);

  const stored = orderRow(FIVE_LINE).detailRawJson;
  assert.equal(stored, sent, 'the stored text is the response body, character for character');

  // The envelope, not the inner object: a key Grab starts returning beside `order`
  // is kept rather than silently dropped on the way in.
  const reread = JSON.parse(stored!) as { order: GrabOrder };
  assert.deepEqual(Object.keys(reread), ['order']);
  assert.deepEqual(reread.order, src);

  // Verbatim means verbatim: nothing is dropped or scrubbed on the way in. These
  // are the keys nothing reads yet, which is exactly why they are worth storing.
  for (const key of ['eater', 'driver', 'times', 'state', 'paymentMethod', 'orderChangeLog', 'incidents', 'voucherInfo', 'orderLevelDiscounts']) {
    assert.ok(key in reread.order, `dropped top-level field: ${key}`);
  }
  assert.equal(Object.keys(reread.order).length, Object.keys(src).length);
});

// The daily report's own int64, off the wire for 001578008445-C8C3KBJWGYE2JN. The
// statement carries the same bitfield the detail payload does — a different value,
// so neither column can pass this by holding the other one's.
const STATEMENT_FLAGS = '4035788216077387780';
const STATEMENT_ROUNDED = '4035788216077388000';

/** One statement as fetchDailyReport hands it over: parsed out of the report, losslessly. */
const statementOf = (id: string) => (parseJsonLossless(
  `{"statements":[{"ID":"${id}","orderFlags":${STATEMENT_FLAGS},"deliveryStatus":"COMPLETED"}]}`,
) as { statements: unknown[] }).statements[0];

test('an int64 reaches BOTH raw columns with every digit intact', () => {
  // Grab's `orderFlags` is a bitfield that does not fit a double: 4035792627008804869
  // parses to 4035792627008805000, drifted by 131, and the low bits — the flags — are
  // gone. Storing a re-serialized parse rounded it on 104 of 104 live orders and
  // collapsed 47 distinct ones onto a single value, unrecoverably, because the
  // endpoint will not serve that history again.
  //
  // Both raw columns are exposed to it and they lose it differently: detail_raw_json
  // holds a body that must never be re-encoded, raw_json holds one statement out of
  // {"statements":[…]} that repo.ts DOES re-encode, so there the parse upstream has
  // to be the lossless one. Fixing either alone leaves the same wrong number on
  // screen two lines away in the order dialog.
  const src = detail(FIVE_LINE);
  // The committed fixture went through a JSON.parse of its own, so its orderFlags is
  // already the rounded double — drop it and splice in the literal off the wire.
  const { orderFlags: _rounded, ...fields } = src;
  const sent = `{"order":{"orderFlags":4035792627008804869,${JSON.stringify(fields).slice(1)}}`;
  upsertOrders([withItems(src, { detailRawJson: sent, rawJson: statementOf(FIVE_LINE) })]);

  const stored = orderRow(FIVE_LINE).detailRawJson!;
  assert.equal(stored, sent);
  assert.match(stored, /"orderFlags":4035792627008804869[,}]/);
  assert.doesNotMatch(stored, /4035792627008805000/, 'the rounded double must not appear anywhere');

  const statementRaw = orderRow(FIVE_LINE).rawJson;
  assert.match(statementRaw, new RegExp(`"orderFlags":${STATEMENT_FLAGS}[,}]`));
  assert.doesNotMatch(statementRaw, new RegExp(STATEMENT_ROUNDED), 'nor in the statement column');

  // raw_json is written by the conflict path as well, and the scheduler re-fetches a
  // trailing two days every night — so the second write has to keep it too.
  upsertOrders([withItems(src, { detailRawJson: sent, rawJson: statementOf(FIVE_LINE), netAmountMinor: 1 })]);
  assert.match(orderRow(FIVE_LINE).rawJson, new RegExp(`"orderFlags":${STATEMENT_FLAGS}[,}]`));

  // And both survive the read path the API serves from, which re-serializes.
  assert.equal(JSON.stringify(parseJsonLossless(stored)), sent);
  assert.match(
    JSON.stringify(parseJsonLossless(statementRaw)),
    new RegExp(`"orderFlags":${STATEMENT_FLAGS}[,}]`),
  );
});

test('every line carries its own payload, stored and read back unchanged', () => {
  const src = detail(FIVE_LINE);
  upsertOrders([withItems(src)]);
  const sourceItems = src.itemInfo!.items!;

  // The stored column first — the string, not just something that deep-equals it.
  const rows = itemRows(rowId(FIVE_LINE));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(r => r.rawJson), sourceItems.map(i => JSON.stringify(i)));

  // Then the read path the API uses, which hands back objects rather than text.
  const items = getOrderItems(rowId(FIVE_LINE));
  assert.deepEqual(items.map(i => i.rawJson), sourceItems);
  assert.equal(typeof items[0].rawJson, 'object');
  // A field the columns deliberately do not carry, recovered from the raw alone.
  assert.equal((items[4].rawJson as Record<string, unknown>).editedStatus, sourceItems[4].editedStatus);
});

test('fare columns land as integers in minor units, with the sentinels NULL and not 0', () => {
  upsertOrders([withItems(detail(FIVE_LINE))]);
  const row = orderRow(FIVE_LINE);

  assert.equal(row.fareTotalMinor, 548000);
  assert.equal(row.fareSubtotalMinor, 548000);
  assert.equal(row.farePassengerTotalMinor, 580000); // what the customer paid
  assert.equal(row.fareDeliveryFeeMinor, 32000);     // '32.000', not 32
  assert.equal(row.fareCommissionMinor, 134466);
  assert.equal(row.fareReducedPriceMinor, 592000);
  // A real zero survives as 0 — `??` not `||` in fareColumns.
  assert.equal(row.fareTaxMinor, 0);
  assert.equal(row.fareSmallOrderFeeMinor, 0);
  // …while Grab's two "none" sentinels are NULL, with the string kept beside them
  // so a sentinel stays distinguishable from a parse that broke.
  assert.deepEqual(
    [row.fareMerchantChargeMinor, row.farePromotionMinor, row.fareTotalDiscountMinor, row.fareAdjustmentByDriverMinor],
    [null, null, null, null],
  );
  assert.deepEqual(
    [row.fareMerchantChargeDisplay, row.farePromotionDisplay, row.fareTotalDiscountDisplay, row.fareAdjustmentByDriverDisplay],
    ['', '-', '', ''],
  );

  // The merchant's take and the customer's payment are different numbers, and
  // neither derives from the other.
  assert.notEqual(row.netAmountMinor, row.farePassengerTotalMinor);
});

test('a re-fetch rewrites raw and fare without duplicating or corrupting them', () => {
  // The scheduler re-fetches a trailing two days every night, so this is the
  // ordinary path, not an edge case.
  upsertOrders([withItems(detail(ITEM_DISCOUNT))]);
  const id = rowId(ITEM_DISCOUNT);
  const before = orderRow(ITEM_DISCOUNT);
  const beforeItems = itemRows(id).map(r => r.rawJson);

  upsertOrders([withItems(detail(ITEM_DISCOUNT))]);

  const after = orderRow(ITEM_DISCOUNT);
  assert.equal(db.select().from(schema.orders).where(eq(schema.orders.id, id)).all().length, 1);
  assert.equal(after.detailRawJson, before.detailRawJson, 'the payload is replaced with itself, not appended to');
  assert.equal(after.detailRawJson!.length, body(detail(ITEM_DISCOUNT)).length);
  assert.equal(after.farePromotionMinor, 67500);
  assert.equal(after.fareTotalDiscountMinor, 67500);
  assert.equal(after.farePassengerTotalMinor, 235500);
  assert.deepEqual(
    [after.fareTotalMinor, after.fareSubtotalMinor, after.fareDeliveryFeeMinor, after.fareCommissionMinor],
    [before.fareTotalMinor, before.fareSubtotalMinor, before.fareDeliveryFeeMinor, before.fareCommissionMinor],
  );

  const afterItems = itemRows(id);
  assert.equal(afterItems.length, 2, 'no duplicated lines');
  assert.deepEqual(afterItems.map(r => r.rawJson), beforeItems, 'and no duplicated or mangled per-line raw');
});

test('a fare figure never outlives the payload it was read from', () => {
  // fareColumns writes the full set every time. A partial write would leave a
  // promotion parsed out of last night's payload sitting beside tonight's lines —
  // the raw-vs-parsed disagreement that storing both is meant to make impossible.
  const promoted = detail(FIVE_LINE);
  promoted.fare!.promotionDisplay = '78.000';
  promoted.fare!.merchantChargeDisplay = '5.000';
  upsertOrders([withItems(promoted)]);

  const withPromo = orderRow(FIVE_LINE);
  assert.equal(withPromo.farePromotionMinor, 78000);
  assert.equal(withPromo.fareMerchantChargeMinor, 5000);

  // The promotion is withdrawn (the real captured payload has none).
  upsertOrders([withItems(detail(FIVE_LINE))]);

  const cleared = orderRow(FIVE_LINE);
  assert.equal(cleared.farePromotionMinor, null);
  assert.equal(cleared.farePromotionDisplay, '-');
  assert.equal(cleared.fareMerchantChargeMinor, null);
  assert.equal(cleared.fareMerchantChargeDisplay, '');
});

test('a refused suspect payload is kept, and clearing it takes a payload being accepted', () => {
  // The write is refused so real lines survive — but the payload itself is the only
  // record of what Grab returned that night, the refusal repeats every night after
  // it, and the endpoint will not serve that night again. Dropping it on the floor
  // was the one outcome nobody could recover from.
  upsertOrders([withItems(detail(FIVE_LINE))]);
  const id = rowId(FIVE_LINE);
  const accepted = orderRow(FIVE_LINE).detailRawJson;
  assert.equal(orderRow(FIVE_LINE).rejectedDetailRawJson, null, 'nothing refused yet');

  const truncated = detail(FIVE_LINE);
  truncated.itemInfo!.items!.length = 3; // a 200 carrying 3 of 5 lines
  const refused = withItems(truncated);
  assert.ok(refused.itemsSuspect);

  const result = upsertOrders([refused]);
  assert.equal(result.itemFailures.length, 1);
  assert.match(result.itemFailures[0].error, /Refusing to overwrite stored items/);

  const frozen = orderRow(FIVE_LINE);
  assert.equal(frozen.rejectedDetailRawJson, refused.detailRawJson, 'the refused body is kept whole');
  assert.equal(frozen.detailRawJson, accepted, 'and never mistaken for the one the stored lines came from');
  assert.equal(frozen.itemsSuspect, null, 'the stored lines are still the verified ones');
  assert.equal(itemRows(id).length, 5);

  // A second refusal overwrites rather than accumulates — it is always the latest.
  upsertOrders([refused]);
  assert.equal(orderRow(FIVE_LINE).rejectedDetailRawJson, refused.detailRawJson);

  // Cleared only by a payload that is actually accepted, so it never outlives the
  // problem it records.
  assert.equal(upsertOrders([withItems(detail(FIVE_LINE))]).itemsWritten, 1);
  assert.equal(orderRow(FIVE_LINE).rejectedDetailRawJson, null);
});

test('an order whose detail was never fetched: raw, fare and timestamp are NULL together', () => {
  // ORDER-1 has only ever been upserted at the order level. detail_raw_json means
  // exactly what items_fetched_at means, and the fare columns move with both.
  const row = orderRow('ORDER-1');
  assert.equal(row.itemsFetchedAt, null);
  assert.equal(row.detailRawJson, null);
  assert.equal(row.rejectedDetailRawJson, null);
  assert.equal(row.itemsSuspect, null);

  const fareColumns = Object.entries(row).filter(([k]) => k.startsWith('fare'));
  assert.equal(fareColumns.length, 16, 'guards the prefix this loop relies on');
  for (const [k, v] of fareColumns) assert.equal(v, null, k);

  // And nothing throws on the read path: the order is still fully serviceable.
  assert.deepEqual(getOrderItems(row.id), []);
  assert.equal(JSON.parse(row.rawJson).ID, 'ORDER-1');
});

test('a failed detail fetch leaves the stored payload and fare alone', () => {
  // The detail call 500s tonight. The order-level row still updates; last night's
  // raw and fare describe the lines that are still stored, so they must survive —
  // blanking them would lose a payload Grab will not serve again.
  upsertOrders([withItems(detail('001578008445-C8C3KBJWGYE2JN'))]);
  const before = orderRow('001578008445-C8C3KBJWGYE2JN');
  assert.notEqual(before.detailRawJson, null);

  upsertOrders([{
    ...order,
    platformOrderId: '001578008445-C8C3KBJWGYE2JN',
    status: 'completed',
    itemsError: 'Grab API error: HTTP 500',
  }]);

  const after = orderRow('001578008445-C8C3KBJWGYE2JN');
  assert.equal(after.status, 'completed', 'order-level data still updated');
  assert.equal(after.detailRawJson, before.detailRawJson);
  assert.equal(after.fareTotalMinor, before.fareTotalMinor);
  assert.equal(after.farePassengerTotalMinor, before.farePassengerTotalMinor);
  assert.equal(after.itemsFetchedAt, before.itemsFetchedAt);
});

test('a line written before raw capture reads back null, and a re-fetch fills it in', () => {
  // The migration adds raw_json nullable — SQLite cannot add a NOT NULL column to
  // a populated table — so the ~298 already-stored orders have NULL here until
  // they are re-fetched. NULL must read as "not captured", not blow up the API.
  const id = rowId(ITEM_DISCOUNT);
  db.update(schema.orderItems)
    .set({ rawJson: null })
    .where(eq(schema.orderItems.orderId, id))
    .run();

  const legacy = getOrderItems(id);
  assert.equal(legacy.length, 2);
  assert.deepEqual(legacy.map(i => i.rawJson), [null, null]);
  assert.equal(legacy[1].discounts[0].amountMinor, 67500, 'every other column still decodes');

  upsertOrders([withItems(detail(ITEM_DISCOUNT))]);
  const refetched = getOrderItems(id);
  assert.equal(refetched.length, 2);
  for (const item of refetched) assert.notEqual(item.rawJson, null);
});

test('a fare Display that is not a string costs one column, never the whole detail write', () => {
  // The regression: the four *Display members were bare passthroughs while the twelve
  // amounts were guarded, so a value that is not a string reached a TEXT column here.
  // better-sqlite3 rejects it and the throw lands INSIDE the transaction below — the
  // line items, all sixteen fare columns and detail_raw_json roll back together, and
  // because it is a DB error rather than the itemsSuspect gate, rejected_detail_raw_json
  // is not written either: the payload is gone and Grab will not serve that night twice.
  // Reproduced before the fix, on this fixture: itemsWritten 0, one itemFailure reading
  // "Too few parameter values were provided", 0 item rows, every column NULL.
  //
  // The shape is one Grab already sends in this very object — chargeFeeDescription and
  // serviceChargeFeeDescription are {en, vi, …} i18n objects on all four fixtures.
  const src = detail(FIVE_LINE);
  (src.fare as Record<string, unknown>).merchantChargeDisplay = { en: 'Merchant charge', vi: 'Phí người bán' };

  const result = upsertOrders([withItems(src)]);
  assert.deepEqual(result.itemFailures, [], 'the detail write must not abort');
  assert.equal(result.itemsWritten, 1);

  const row = orderRow(FIVE_LINE);
  assert.equal(itemRows(row.id).length, 5, 'the lines land');
  assert.equal(row.detailRawJson, body(src), 'so does the payload this column exists to keep');
  assert.notEqual(row.itemsFetchedAt, null);
  assert.equal(row.rejectedDetailRawJson, null, 'nothing was refused — the payload was accepted');
  assert.equal(row.fareTotalMinor, 548000, 'and every readable fare figure with them');
  // The unreadable figure is the only casualty, in both of its columns.
  assert.equal(row.fareMerchantChargeMinor, null);
  assert.equal(row.fareMerchantChargeDisplay, null);

  // What that guard is standing between, in one statement: the same value, bound.
  assert.throws(
    () => db.update(schema.orders)
      .set({ fareMerchantChargeDisplay: src.fare!.merchantChargeDisplay as unknown as string })
      .where(eq(schema.orders.id, row.id))
      .run(),
    /parameter values/,
  );

  // A one-element array is the quieter half of the same bug: better-sqlite3 reads it
  // as positional parameters and stores its first element with no error at all, so a
  // column that means "what Grab printed" would answer with something Grab never did.
  const arrayed = detail(FIVE_LINE);
  (arrayed.fare as Record<string, unknown>).promotionDisplay = ['67.500'];
  assert.deepEqual(upsertOrders([withItems(arrayed)]).itemFailures, []);
  assert.equal(orderRow(FIVE_LINE).farePromotionDisplay, null, 'not "67.500"');

  // …and the next clean payload puts the real sentinels back: no column is stuck.
  upsertOrders([withItems(detail(FIVE_LINE))]);
  const cleaned = orderRow(FIVE_LINE);
  assert.equal(cleaned.fareMerchantChargeDisplay, '');
  assert.equal(cleaned.farePromotionDisplay, '-');
});

// ===== One malformed order costs one order =====
// Six order-level values come off the remote payload and bind to a NOT NULL column.
// They all used to go in unchecked, inside phase 1's single transaction, so ONE of
// them arriving in the wrong shape rolled back every order-level row in the batch and
// the items phase never ran — reproduced on a 3-order batch with one object-valued
// deliveryStatus: 0 of 3 stored, and an error string ('You cannot specify named
// parameters in two different objects') naming neither the order nor the field.

/** A live statement's shape. Real values; the malformation is always spliced in. */
const statement = (id: string, over: Record<string, unknown> = {}): GrabStatement => ({
  ID: id,
  bookingCode: `A-${id.slice(-8)}`,
  currency: { code: 'VND', symbol: '₫', exponent: '0', exponentUnit: 0 },
  orderEarningsInMinorUnit: 119600,
  deliveryStatus: 'COMPLETED',
  createdAt: '2026-08-03T09:12:44Z',
  updatedAt: '2026-08-03T09:51:02.418733Z',
  priceDisplay: '119.600',
  displayID: id.slice(-6),
  ...over,
});

/** The connector's own path: statement → normalizeOrder → upsertOrders. */
const normalized = (s: GrabStatement) => normalizeOrder(s, 'acct-1', 'merch-1', 'Asia/Ho_Chi_Minh', '2026-08-03');

test('one malformed order in a batch costs exactly itself', () => {
  // The reproduction, as a property: five real orders and one whose deliveryStatus
  // arrived as an i18n object — a shape Grab already sends in the sibling fare object
  // (chargeFeeDescription, serviceChargeFeeDescription are both {en, vi, …}).
  const batch = [
    statement('001000000001-BATCHAAAAAAAAA'),
    statement('001000000002-BATCHBBBBBBBBB'),
    statement('001000000003-BATCHCCCCCCCCC', { deliveryStatus: { en: 'COMPLETED', vi: 'HOÀN THÀNH' } }),
    statement('001000000004-BATCHDDDDDDDDD'),
    statement('001000000005-BATCHEEEEEEEEE'),
    statement('001000000006-BATCHFFFFFFFFF'),
  ].map(normalized);

  const result = upsertOrders(batch);

  assert.equal(result.stored.length, 5, 'five of six landed');
  assert.equal(result.orderFailures.length, 1);
  assert.equal(result.orderFailures[0].platformOrderId, '001000000003-BATCHCCCCCCCCC');
  assert.match(result.orderFailures[0].error, /^platformStatus is not a status string: object /);

  const ids = batch.map(o => o.platformOrderId).filter(id => typeof id === 'string');
  for (const id of ids) {
    const row = db.select().from(schema.orders)
      .where(and(eq(schema.orders.platform, 'grab'), eq(schema.orders.platformOrderId, id))).get();
    if (id === '001000000003-BATCHCCCCCCCCC') assert.equal(row, undefined, 'the bad apple, and only it');
    else assert.equal(row?.netAmountMinor, 119600, id);
  }
});

test('each of the six loses its own order and no other', () => {
  // One batch, one malformation per field, plus a clean order to prove the batch
  // itself still commits. Reintroduce any single guard removal and exactly one of
  // these six goes quiet.
  const malformations: [string, Record<string, unknown>, RegExp][] = [
    ['id', { ID: { en: 'x' }, bookingCode: '' }, /^platformOrderId /],
    ['status', { deliveryStatus: ['COMPLETED'] }, /^platformStatus /],
    ['earnings', { orderEarningsInMinorUnit: '119.600' }, /^netAmountMinor /],
    ['currency', { currency: { code: ['VND'] } }, /^currency /],
    ['ordered', { createdAt: undefined }, /^orderedAt /],
    ['updated', { updatedAt: 1785958222 }, /^updatedAt /],
  ];

  const batch = [
    normalized(statement('001000000007-SIXCLEANAAAA')),
    ...malformations.map(([tag, over]) => normalized(statement(`001000000008-SIX${tag.toUpperCase()}`, over))),
  ];

  const result = upsertOrders(batch);

  assert.equal(result.stored.length, 1, 'only the clean one');
  assert.equal(result.orderFailures.length, 6);
  for (const [i, [tag, , expected]] of malformations.entries()) {
    assert.match(result.orderFailures[i].error, expected, tag);
  }
  // The id-less one still names something an operator can act on.
  assert.equal(result.orderFailures[0].platformOrderId, '(no id, grab/2026-08-03)');
  assert.equal(result.orderFailures[1].platformOrderId, '001000000008-SIXSTATUS');
  assert.notEqual(
    db.select().from(schema.orders)
      .where(eq(schema.orders.platformOrderId, '001000000007-SIXCLEANAAAA')).get(),
    undefined,
  );
});

test('a rejected order never reaches the item phase', () => {
  // Phase 2 resolves its row by (platform, platform_order_id). An order with no row
  // would fail there a second time, reported as a missing row rather than as the
  // field that actually stopped it — one problem, two entries, neither of them true.
  const src = detail(FIVE_LINE);
  const doomed = withItems(src, {
    platformOrderId: '001000000009-NOITEMPHASE',
    currency: 12 as unknown as string,
  });

  const result = upsertOrders([doomed]);

  assert.equal(result.orderFailures.length, 1);
  assert.match(result.orderFailures[0].error, /^currency is not a currency code: number 12/);
  assert.deepEqual(result.itemFailures, [], 'exactly one failure, and it is the real one');
  assert.equal(result.itemsWritten, 0);
  assert.equal(
    db.select().from(schema.orders).where(eq(schema.orders.platformOrderId, '001000000009-NOITEMPHASE')).get(),
    undefined,
  );
});

test("a malformed re-fetch leaves last night's row exactly as it was", () => {
  // The scheduler re-fetches a trailing window every night, so an order that is
  // already stored gets a fresh payload nightly. A payload that goes bad must not
  // overwrite a good row, and must not delete it either.
  upsertOrders([normalized(statement('001000000010-REFETCHAAAA'))]);
  const before = db.select().from(schema.orders)
    .where(eq(schema.orders.platformOrderId, '001000000010-REFETCHAAAA')).get()!;

  const result = upsertOrders([normalized(statement('001000000010-REFETCHAAAA', {
    orderEarningsInMinorUnit: { amount: 200000 },
    deliveryStatus: 'CANCELLED_PASSENGER',
  }))]);

  assert.equal(result.orderFailures.length, 1);
  assert.match(result.orderFailures[0].error, /^netAmountMinor /);
  assert.deepEqual(
    db.select().from(schema.orders).where(eq(schema.orders.platformOrderId, '001000000010-REFETCHAAAA')).get(),
    before,
    'not updated, not deleted — untouched',
  );
});

test('what the guard stands between: the same values, bound', () => {
  // Every row here was measured against this schema, and it is why the guard is a
  // check and not a try/catch. NOT NULL is the only constraint SQLite enforces on a
  // column's contents — the declared type is an affinity, so a value of the wrong
  // kind is stored, converted, or read as positional parameters, and only two of
  // these six raise anything at all.
  upsertOrders([normalized(statement('001000000011-BINDPROOFA'))]);
  const id = rowId('001000000011-BINDPROOFA');
  const set = (values: Record<string, unknown>) =>
    db.update(schema.orders).set(values).where(eq(schema.orders.id, id)).run();
  const row = () => db.select().from(schema.orders).where(eq(schema.orders.id, id)).get()!;

  // Grab's own way of printing 312.000 đồng, into the INTEGER column revenue is
  // summed from. Off by three orders of magnitude, in silence.
  set({ netAmountMinor: '312.000' });
  assert.equal(row().netAmountMinor, 312);
  // Text in an INTEGER column: SQLite converts only when it is lossless, and keeps
  // the rest as text. sum() then reads it as 0.
  set({ netAmountMinor: 'abc' });
  assert.equal(row().netAmountMinor, 'abc' as unknown as number);
  // A one-element array is not rejected — better-sqlite3 reads it as positional
  // parameters and binds its first element. This is the case a catch never sees.
  set({ currency: ['THB'] as unknown as string });
  assert.equal(row().currency, 'THB');
  // A number into a TEXT column comes back as something the platform never sent.
  set({ currency: 704 as unknown as string });
  assert.equal(row().currency, '704.0');
  // Only these two raise, and neither says which order or which field.
  assert.throws(() => set({ platformStatus: { en: 'COMPLETED' } as unknown as string }), /parameter values/);
  assert.throws(() => set({ platformStatus: ['A', 'B'] as unknown as string }), /parameter values/);

  // …and the guard refuses every one of them before a statement is ever prepared.
  for (const [field, value] of [
    ['netAmountMinor', '312.000'], ['netAmountMinor', 'abc'],
    ['currency', ['THB']], ['currency', 704],
    ['platformStatus', { en: 'COMPLETED' }], ['platformStatus', ['A', 'B']],
  ] as [string, unknown][]) {
    const result = upsertOrders([{ ...order, platformOrderId: '001000000012-GUARDPROOF', [field]: value }]);
    assert.equal(result.stored.length, 0, `${field}=${JSON.stringify(value)}`);
    assert.match(result.orderFailures[0].error, new RegExp(`^${field} `));
  }
  assert.equal(
    db.select().from(schema.orders).where(eq(schema.orders.platformOrderId, '001000000012-GUARDPROOF')).get(),
    undefined,
    'nothing of it was written, not even a first array element',
  );
});

test('an order that fails inside the transaction still costs only itself', () => {
  // The backstop, for what the guard cannot enumerate: rawJson is stringified on the
  // way into a NOT NULL column, and JSON.stringify(undefined) is undefined, which
  // drizzle drops from the statement altogether. Before, that was another whole-batch
  // rollback; the failure has to be isolated even when it is not one of the six.
  const result = upsertOrders([
    normalized(statement('001000000013-TXBACKSTOP')),
    { ...order, platformOrderId: '001000000014-TXNORAWJSON', rawJson: undefined },
    normalized(statement('001000000015-TXAFTERBAD')),
  ]);

  assert.equal(result.stored.length, 2);
  assert.equal(result.orderFailures.length, 1);
  assert.equal(result.orderFailures[0].platformOrderId, '001000000014-TXNORAWJSON');
  assert.match(result.orderFailures[0].error, /NOT NULL constraint failed: orders.raw_json/);
  // Both sides of the bad one committed — the transaction was not rolled back, and
  // the one after it was not skipped.
  for (const id of ['001000000013-TXBACKSTOP', '001000000015-TXAFTERBAD']) {
    assert.notEqual(db.select().from(schema.orders).where(eq(schema.orders.platformOrderId, id)).get(), undefined, id);
  }
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

// ===== what the incremental fetch reads and writes =====
//
// At a 3-minute tick the detail phase must ask the database what it already has and
// then, for almost every order, do nothing at all. These are the two halves of that:
// the lookup that feeds the decision, and the guarantee that a skipped order is left
// alone right down to its timestamps.
//
// Own order ids, own business day: these assert on NULL clocks and on rows not moving,
// which the fixtures above have already written to.

const INC_DAY = '2026-08-09';
const INC_A = '001000000101-INCAAAAAAAAAA'; // FIVE_LINE's payload
const INC_B = '001000000102-INCBBBBBBBBBB'; // ITEM_DISCOUNT's
const INC_C = '001000000103-INCCCCCCCCCCC'; // MULTI_QTY's

/** One order of that day, carrying a real payload under a private id. */
const inc = (src: GrabOrder, platformOrderId: string, over: Partial<UnifiedOrder> = {}) =>
  withItems(src, { platformOrderId, reportDate: INC_DAY, updatedAt: '2026-08-09T10:00:00Z', ...over });

test('a line-item write records which version of the order its lines describe', () => {
  // detail_updated_at is what the skip decision compares the daily report against, so
  // it has to be the platform timestamp of the payload the stored lines came from —
  // and it may only move when the lines do.
  upsertOrders([inc(detail(FIVE_LINE), INC_A)]);
  assert.equal(orderRow(INC_A).detailUpdatedAt, '2026-08-09T10:00:00Z');

  // The order is edited; a fresh payload lands and the marker follows it.
  upsertOrders([inc(detail(FIVE_LINE), INC_A, { updatedAt: '2026-08-09T10:31:00Z' })]);
  assert.equal(orderRow(INC_A).detailUpdatedAt, '2026-08-09T10:31:00Z');

  // The same order upserted with NO payload (a skipped or failed detail call) must not
  // move it, or the lines would claim to describe a version they were never fetched for.
  upsertOrders([inc(detail(FIVE_LINE), INC_A, {
    updatedAt: '2026-08-09T11:00:00Z', items: undefined, detailRawJson: undefined,
  })]);
  const row = orderRow(INC_A);
  assert.equal(row.updatedAt, '2026-08-09T11:00:00Z', 'the report still refreshes the order-level row every tick');
  assert.equal(row.detailUpdatedAt, '2026-08-09T10:31:00Z', 'but the lines still describe the version they came from');
});

test('the retry clock moves only for orders the detail phase actually touched', () => {
  const attempted = inc(detail(ITEM_DISCOUNT), INC_B);
  const failed = inc(detail(MULTI_QTY), INC_C, { items: undefined, itemsError: 'Grab API error: HTTP 500' });
  // Neither a payload nor an error: the connector skipped it. Stamping this one would
  // restart the cooldown it is measured against on every tick, so nothing genuinely
  // broken would ever come up for retry again.
  const skipped = inc(detail(FIVE_LINE), '001000000104-INCDDDDDDDDDD', { items: undefined, detailRawJson: undefined });

  upsertOrders([attempted, failed, skipped]);

  assert.notEqual(orderRow(INC_B).detailAttemptedAt, null, 'a payload arrived');
  assert.notEqual(orderRow(INC_C).detailAttemptedAt, null, 'a call went out and failed');
  assert.equal(orderRow('001000000104-INCDDDDDDDDDD').detailAttemptedAt, null, 'nobody looked at this one');
});

test('a skipped order keeps its rows, its items_fetched_at and its clocks', async () => {
  // The contract the whole feature rests on. "When did we last verify this order"
  // stops meaning anything the moment a run that skipped the order touches it.
  const ID = '001000000105-INCEEEEEEEEEE';
  upsertOrders([inc(detail(MULTI_QTY), ID)]);
  const id = rowId(ID);
  const before = orderRow(ID);
  const beforeItems = itemRows(id);
  const beforeModifiers = modifierRows(id);
  assert.ok(before.itemsFetchedAt);
  assert.equal(beforeItems.length, 2);

  // Enough for a second write to land on a different ISO millisecond, so an
  // accidental re-stamp cannot pass by looking identical.
  await new Promise(r => setTimeout(r, 5));

  // The next tick: the daily report still carries this order (its status moved), but
  // the connector decided its lines are current and sent no payload.
  const result = upsertOrders([inc(detail(MULTI_QTY), ID, {
    items: undefined,
    detailRawJson: undefined,
    fare: undefined,
    status: 'cancelled',
    platformStatus: 'CANCELLED',
    updatedAt: '2026-08-09T12:00:00Z',
  })]);
  assert.equal(result.itemsWritten, 0);
  assert.deepEqual(result.itemFailures, []);

  const after = orderRow(ID);
  assert.equal(after.status, 'cancelled', 'the order-level row IS refreshed — that is the cheap half');
  // …and nothing the detail phase owns moved.
  assert.equal(after.itemsFetchedAt, before.itemsFetchedAt, 'items_fetched_at still says when the lines were last confirmed');
  assert.equal(after.detailUpdatedAt, before.detailUpdatedAt);
  assert.equal(after.detailAttemptedAt, before.detailAttemptedAt);
  assert.equal(after.detailRawJson, before.detailRawJson, 'the payload the lines came from is still there');
  assert.equal(after.fareTotalMinor, before.fareTotalMinor, 'and the money parsed out of it');
  assert.equal(after.itemsSuspect, before.itemsSuspect);
  // Same rows, same surrogate ids: not deleted and re-inserted with identical values.
  assert.deepEqual(itemRows(id), beforeItems);
  assert.deepEqual(modifierRows(id), beforeModifiers);
});

test('getStoredOrderDetail answers a whole business day, scoped to one account', () => {
  db.insert(schema.merchants).values({ id: 'merch-2', name: 'Other Merchant' }).onConflictDoNothing().run();
  db.insert(schema.platformAccounts).values({
    id: 'acct-2', merchantId: 'merch-2', platform: 'grab', label: 'other', credentialKey: 'k',
  }).onConflictDoNothing().run();

  const MINE = '001000000106-INCFFFFFFFFFF';
  const THEIRS = '001000000107-INCGGGGGGGGGG';
  const OTHER_DAY = '001000000108-INCHHHHHHHHHH';
  upsertOrders([
    inc(detail(FIVE_LINE), MINE, { updatedAt: '2026-08-09T13:00:00Z' }),
    inc(detail(ITEM_DISCOUNT), THEIRS, { accountId: 'acct-2', merchantId: 'merch-2' }),
    inc(detail(MULTI_QTY), OTHER_DAY, { reportDate: '2026-08-10' }),
  ]);

  const day = getStoredOrderDetail('acct-1', INC_DAY);
  assert.ok(day.has(MINE));
  assert.ok(!day.has(THEIRS), "another account's order is not this account's business");
  assert.ok(!day.has(OTHER_DAY), 'and neither is another day');

  // Everything the rule needs, and nothing it does not — the ~13 KB payload columns
  // are never selected, only asked whether they are null.
  assert.deepEqual(day.get(MINE), {
    updatedAt: '2026-08-09T13:00:00Z',
    detailUpdatedAt: '2026-08-09T13:00:00Z',
    detailAttemptedAt: orderRow(MINE).detailAttemptedAt,
    itemsSuspect: null,
    rejected: false,
  });
});

test('getStoredOrderDetail reports a frozen order as rejected', () => {
  // Reached the only way it can be: a suspect payload refused over lines we already
  // have. That order must keep coming up for retry, so the lookup has to see it.
  const ID = '001000000109-INCIIIIIIIIII';
  upsertOrders([inc(detail(FIVE_LINE), ID)]);
  const truncated = detail(FIVE_LINE);
  truncated.itemInfo!.items!.length = 3;
  const refused = inc(truncated, ID, { updatedAt: '2026-08-09T14:00:00Z' });
  assert.ok(refused.itemsSuspect);
  assert.equal(upsertOrders([refused]).itemFailures.length, 1);

  const stored = getStoredOrderDetail('acct-1', INC_DAY).get(ID)!;
  assert.equal(stored.rejected, true);
  // And it is genuinely stale: the report has moved past what the stored lines describe.
  assert.equal(stored.updatedAt, '2026-08-09T14:00:00Z');
  assert.notEqual(stored.detailUpdatedAt, stored.updatedAt);
});
