import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeOrder, normalizeOrderItems } from './normalize.js';
import { GrabOrder, GrabStatement } from './api.js';

const fixtures = JSON.parse(readFileSync(new URL('../../../data/sample-orders-for-mapping.json', import.meta.url), 'utf8'));
const orders: GrabStatement[] = fixtures.grab_orders;

const completed = orders.find(o => o.deliveryStatus === 'COMPLETED')!;
const executing = orders.find(o => o.deliveryStatus === 'ORDER_EXECUTING')!;

const norm = (s: GrabStatement) => normalizeOrder(s, 'acct-1', 'merch-1', 'Asia/Ho_Chi_Minh', '2026-07-14');

test('COMPLETED maps to completed', () => {
  assert.equal(norm(completed).status, 'completed');
  assert.equal(norm(completed).platformStatus, 'COMPLETED');
});

test('ORDER_EXECUTING maps to in_progress', () => {
  assert.equal(norm(executing).status, 'in_progress');
});

test('unknown deliveryStatus maps to other, not in_progress', () => {
  const u = norm({ ...completed, deliveryStatus: 'SOME_NEW_STATUS' });
  assert.equal(u.status, 'other');
  assert.equal(u.platformStatus, 'SOME_NEW_STATUS');
});

test('FAILED maps to cancelled', () => {
  // fixture set has no FAILED order — derive one from a real fixture
  assert.equal(norm({ ...completed, deliveryStatus: 'FAILED' }).status, 'cancelled');
});

test('cancelRole present forces cancelled regardless of deliveryStatus', () => {
  assert.equal(norm({ ...completed, cancelRole: 'PASSENGER' }).status, 'cancelled');
});

test('cancelledAt present forces cancelled regardless of deliveryStatus', () => {
  assert.equal(norm({ ...completed, cancelledAt: '2026-07-14T06:00:00Z' }).status, 'cancelled');
});

test('empty cancelRole and null cancelledAt do NOT mean cancelled (real fixture shape)', () => {
  assert.equal(completed.cancelRole, '');
  assert.equal(completed.cancelledAt, null);
  assert.equal(norm(completed).status, 'completed');
});

test('grossAmountMinor is null (Grab provides net only)', () => {
  assert.equal(norm(completed).grossAmountMinor, null);
  assert.equal(norm(completed).netAmountMinor, completed.orderEarningsInMinorUnit);
});

test('currency code extracted from currency object', () => {
  assert.equal(norm(completed).currency, 'VND');
});

test('platformOrderId uses ID, falls back to bookingCode', () => {
  assert.equal(norm(completed).platformOrderId, completed.ID);
  assert.equal(norm({ ...completed, ID: '' }).platformOrderId, completed.bookingCode);
});

test('passthrough fields: timestamps, timezone, rawJson', () => {
  const u = norm(completed);
  assert.equal(u.orderedAt, completed.createdAt);
  assert.equal(u.updatedAt, completed.updatedAt);
  assert.equal(u.platformTimezone, 'Asia/Ho_Chi_Minh');
  assert.equal(u.rawJson, completed);
  assert.equal(u.platform, 'grab');
});

// ===== normalizeOrderItems =====
// Fixtures are real v3 order-detail payloads (data/sample-order-details.json);
// only driver/customer personal fields were scrubbed — see that file's _scrubbed note.

const details: GrabOrder[] = JSON.parse(
  readFileSync(new URL('../../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders;

const detail = (orderId: string): GrabOrder => {
  const found = details.find(o => o.orderID === orderId);
  if (!found) throw new Error(`fixture missing: ${orderId}`);
  return structuredClone(found); // callers mutate copies to build the edge cases
};

// VND — every captured order. grabCurrencyExponent is exercised in money.test.ts.
const normItems = (o: GrabOrder) => normalizeOrderItems(o, o.orderID, 0);

const MULTI_ITEM = '001652323231-C8C3JTXZJGMTTJ'; // 5 lines, 14 modifier groups, 15 modifiers
const MULTI_QTY = '001353210567-C8CYWELHLPMEEJ';  // 2 lines, one of them quantity 2
const ITEM_DISCOUNT = '001510457039-C8C3KEBVELCJVT'; // line-level 50% promo

test('multi-item order: every line survives, in payload order, keyed by itemKey', () => {
  const src = detail(MULTI_ITEM);
  const { items, suspect } = normItems(src);

  assert.equal(suspect, undefined);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(i => i.position), [0, 1, 2, 3, 4]);
  // itemKey is stable across re-fetches (hand-verified), which is what makes the
  // rewrite in replaceOrderItems idempotent rather than merely repeatable.
  assert.deepEqual(items.map(i => i.lineKey), src.itemInfo!.items!.map(i => i.itemKey));
  assert.equal(items[0].name, 'Bánh Mì Trứ Danh Đong Đầy');
  assert.equal(items[0].platformItemId, 'VNITE20251202062935031048');
});

test('nested modifier groups flatten into ordered rows that keep their group identity', () => {
  const { items } = normItems(detail(MULTI_ITEM));
  assert.equal(items.reduce((n, i) => n + i.modifiers.length, 0), 15);

  // Line 4 is the interesting one: 3 groups, but TOPPINGS contributes two options,
  // so a per-group Map keyed on modifierGroupID would lose one of them.
  const line = items[4];
  assert.equal(line.modifiers.length, 4);
  assert.deepEqual(line.modifiers.map(m => m.position), [0, 1, 2, 3]);

  const toppings = line.modifiers.filter(m => m.groupName === 'TOPPINGS BÁNH MÌ');
  assert.equal(toppings.length, 2);
  assert.equal(toppings[0].groupId, toppings[1].groupId);
  assert.deepEqual(toppings.map(m => m.name), ['🍳1 Trứng Ốp La', '🥒Túi Rau Thêm']);
  assert.deepEqual(toppings.map(m => m.priceMinor), [20000, 10000]);
  assert.deepEqual(toppings.map(m => m.priceDisplay), ['20.000', '10.000']);
  assert.equal(toppings[0].platformModifierId?.startsWith('VNMOD'), true);
});

test('a free option is priceMinor 0, never null — null is reserved for "did not parse"', () => {
  const { items } = normItems(detail(MULTI_ITEM));
  const free = items[1].modifiers; // MỨC ĐÁ / MỨC ĐƯỜNG, both '0'
  assert.deepEqual(free.map(m => m.priceDisplay), ['0', '0']);
  assert.deepEqual(free.map(m => m.priceMinor), [0, 0]);
});

test('fare.priceInMin is PER UNIT: a quantity-2 line totals twice it', () => {
  // The assumption this replaces — priceInMin as the line total — was true only
  // because every earlier fixture happened to be quantity 1. It undercounts a
  // qty-2 line by half, silently, with nothing in the row to contradict it.
  const { items } = normItems(detail(MULTI_QTY));
  const line = items[0];

  assert.equal(line.quantity, 2);
  assert.equal(line.unitPriceMinor, 109000);
  assert.equal(line.lineTotalMinor, 218000);
  // Grab's own display string for the line agrees with the product, not the unit.
  assert.equal(line.lineTotalMinor, 218000, 'fare.priceDisplay is "218.000"');
});

test('originalItemPriceDisplay is line-scoped, unlike priceInMin', () => {
  // 59.000 a unit, reported as '118.000' on a qty-2 line. Scaling it again by
  // quantity would double-count the base of every multi-quantity line.
  const { items } = normItems(detail(MULTI_QTY));
  assert.equal(items[0].baseTotalDisplay, '118.000');
  assert.equal(items[0].baseTotalMinor, 118000);
});

test('itemInfo.count counts units, not lines — a quantity-2 order is not suspect', () => {
  // The rejected design asserted count === items.length, which would have flagged
  // every correct multi-quantity order as truncated.
  const src = detail(MULTI_QTY);
  assert.equal(src.itemInfo!.count, 3);
  assert.equal(src.itemInfo!.items!.length, 2);

  const { items, suspect } = normItems(src);
  assert.equal(suspect, undefined);
  assert.equal(items.reduce((n, i) => n + i.quantity, 0), 3);
});

test('line totals sum to fare.originalPriceInMin on every captured order', () => {
  assert.equal(details.length, 4);
  for (const src of details) {
    const { items, suspect } = normItems(structuredClone(src));
    const sum = items.reduce((n, i) => n + i.lineTotalMinor, 0);
    assert.equal(sum, src.fare!.originalPriceInMin, src.orderID);
    assert.equal(suspect, undefined, src.orderID);
  }
});

test('the schema self-check holds on every line: base + qty * Σ(modifiers) = line total', () => {
  for (const src of details) {
    for (const line of normItems(structuredClone(src)).items) {
      const mods = line.modifiers.reduce((n, m) => n + (m.priceMinor ?? 0), 0);
      assert.equal(
        (line.baseTotalMinor ?? 0) + line.quantity * mods,
        line.lineTotalMinor,
        `${src.orderID} line ${line.position}`,
      );
    }
  }
});

test('an item discount is the amount taken off, not the discounted price', () => {
  // Grab names the field itemDiscountPriceDisplay, which reads like a price. On a
  // 155.000 line under a promo named "GIẢM 50%" it is 67.500 — the deduction.
  const { items } = normItems(detail(ITEM_DISCOUNT));
  const line = items[1];
  assert.equal(line.lineTotalMinor, 155000);
  assert.equal(line.discounts.length, 1);
  assert.equal(line.discounts[0].amountMinor, 67500); // not 67.5, not 87500
  assert.equal(line.discounts[0].amountDisplay, '67.500');
  assert.equal(line.discounts[0].type, 'percentage');
  assert.equal(line.discountMinor, 67500);
  // Lines without one get null, never 0 — 0 would read as "a discount of nothing".
  assert.equal(items[0].discountMinor, null);
});

test('an unparseable discount amount poisons discountMinor rather than understating it', () => {
  const src = detail(ITEM_DISCOUNT);
  src.itemInfo!.items![1].discountInfo![0].itemDiscountPriceDisplay = '67.5k';
  const { items } = normItems(src);
  assert.equal(items[1].discounts[0].amountMinor, null);
  assert.equal(items[1].discounts[0].amountDisplay, '67.5k'); // raw string kept for a SQL fix
  assert.equal(items[1].discountMinor, null);
  // The line total is an integer Grab gave us, so the money that matters survives.
  assert.equal(items[1].lineTotalMinor, 155000);
});

test('a modifier whose price string stops parsing does not discard the order', () => {
  const src = detail(MULTI_ITEM);
  src.itemInfo!.items![0].modifierGroups![1].modifiers![0].priceDisplay = '₫70.000';
  const { items } = normItems(src);
  assert.equal(items.length, 5);
  assert.equal(items[0].modifiers[1].priceMinor, null);
  assert.equal(items[0].modifiers[1].priceDisplay, '₫70.000');
  assert.equal(items[0].lineTotalMinor, 169000);
});

test("a modifier priced '' is null, not 0 — the sentinel is not a free option", () => {
  // '' is Grab's "no value" sentinel (it is what merchantChargeDisplay carries).
  // Storing 0 for it would assert the option is free; null says we do not know,
  // and price_display keeps the original either way.
  const src = detail(MULTI_ITEM);
  src.itemInfo!.items![0].modifierGroups![1].modifiers![0].priceDisplay = '';
  const { items } = normItems(src);
  assert.equal(items[0].modifiers[1].priceMinor, null);
  assert.equal(items[0].modifiers[1].priceDisplay, '');
});

test('a truncated payload is flagged suspect, not trusted', () => {
  // A 200 carrying 1 of 2 lines is indistinguishable from an edited order that
  // lost one — except that the declared totals stop reconciling.
  const src = detail(MULTI_QTY);
  src.itemInfo!.items!.pop();
  const { items, suspect } = normItems(src);

  assert.equal(items.length, 1);
  assert.match(suspect!, /itemInfo\.count 3 != 2 units/);
  assert.match(suspect!, /line totals 218000 != fare\.originalPriceInMin 317000/);
});

test('a detail response for a different order throws — it is never written onto ours', () => {
  const src = detail(MULTI_ITEM);
  assert.throws(
    () => normalizeOrderItems(src, MULTI_QTY, 0),
    /order detail mismatch: asked for 001353210567/,
  );
});

test('missing or empty itemInfo throws rather than returning zero lines', () => {
  // Deliberate: replaceOrderItems deletes before it inserts, so "no items" as a
  // value would wipe an order's real lines. The connector catches this per order
  // (order.itemsError) and the stored rows are left alone — see repo.test.ts.
  for (const itemInfo of [undefined, null, {}, { count: 0, items: [] }, { count: 2, items: null }]) {
    const src = detail(MULTI_ITEM);
    src.itemInfo = itemInfo as GrabOrder['itemInfo'];
    assert.throws(() => normItems(src), /returned no items/, JSON.stringify(itemInfo));
  }
});

test('a line with no usable priceInMin or quantity throws — the total is a product', () => {
  const noPrice = detail(MULTI_ITEM);
  noPrice.itemInfo!.items![0].fare!.priceInMin = undefined;
  assert.throws(() => normItems(noPrice), /no usable fare\.priceInMin/);

  const badQty = detail(MULTI_ITEM);
  badQty.itemInfo!.items![0].quantity = 0;
  assert.throws(() => normItems(badQty), /unusable quantity/);
});

test('lineKey falls back to a synthesized key so the unique index stays real', () => {
  // line_key is NOT NULL and unique per order; SQLite treats NULLs as distinct,
  // so a missing itemKey must not become one.
  const src = detail(MULTI_ITEM);
  src.itemInfo!.items![0].itemKey = '';
  const { items } = normItems(src);
  assert.equal(items[0].lineKey, 'VNITE20251202062935031048#0');
});

test('GrabFood merchant ids are empty strings, and are stored as-is', () => {
  // Nothing may depend on these being populated: this account has no UI path to
  // set them. platformItemId (Grab's catalog id) is the real identifier.
  const { items } = normItems(detail(MULTI_ITEM));
  assert.deepEqual(items.map(i => i.skuId), ['', '', '', '', '']);
  assert.deepEqual(items.map(i => i.itemCode), ['', '', '', '', '']);
});
