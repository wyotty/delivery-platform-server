import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeOrder, normalizeOrderFare, normalizeOrderItems } from './normalize.js';
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

test('no invented defaults: an absent earnings figure or currency is handed on as it is', () => {
  // `?? 0` and `?? 'VND'` used to happen right here, and both were values a NOT NULL
  // column accepts with nothing in the row to contradict them: 0 is a real earnings
  // figure a cancelled order genuinely reports, and VND is one country's currency on
  // a platform that runs across SEA. What arrived is what is handed on; whether it
  // can be stored is core/order-guard.ts's decision, and it names the field.
  const { orderEarningsInMinorUnit: _e, currency: _c, ...rest } = completed;
  const bare = norm(rest as GrabStatement);
  assert.equal(bare.netAmountMinor, undefined);
  assert.equal(bare.currency, undefined);

  // A currency object with no code, and one that is not an object at all. The `?.`
  // is why these are values this normalizer hands on rather than a TypeError that
  // would cost the whole day's map before a single order was stored.
  assert.equal(norm({ ...completed, currency: {} as GrabStatement['currency'] }).currency, undefined);
  assert.equal(norm({ ...completed, currency: null as unknown as GrabStatement['currency'] }).currency, undefined);

  // Nothing is coerced on the way past either — '119.600' is Grab's way of printing
  // a hundred and nineteen thousand six hundred, and Number() of it is 119.
  assert.equal(
    norm({ ...completed, orderEarningsInMinorUnit: '119.600' as unknown as number }).netAmountMinor,
    '119.600' as unknown as number,
  );

  // Meanwhile a real zero is still a zero. It used to be indistinguishable from the
  // default that replaced a missing one; now they are different outcomes entirely.
  assert.equal(norm({ ...completed, orderEarningsInMinorUnit: 0 }).netAmountMinor, 0);
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

test('each line carries the platform item object itself — no copy, no pick, no scrub', () => {
  // Identity, not deep equality: a defensive copy here is where a future "just
  // tidy this up" quietly starts dropping the fields the column exists for.
  const src = detail(MULTI_ITEM);
  const { items } = normItems(src);
  for (const [i, line] of items.entries()) {
    assert.equal(line.rawJson, src.itemInfo!.items![i], `line ${i}`);
  }

  // The point of the column: the ~16 per-line fields nothing reads yet survive,
  // including the ones whose value is null/'' and would vanish under a pick list.
  const raw = items[0].rawJson as Record<string, unknown>;
  for (const key of [
    'editedStatus', 'weight', 'soldByWeight', 'specialItemType', 'itemTags',
    'outOfStockInstruction', 'outOfStockInstructionV2', 'parentID', 'parentName',
    'isAddedAsReplacement', 'isUneditable', 'image', 'originalItem', 'originalFare',
    'memberPriceInfo', 'barcode',
  ]) {
    assert.ok(key in raw, `dropped per-item field: ${key}`);
  }
});

// ===== normalizeOrderFare =====
// Same real payloads. Every figure below is a display string in Grab's response —
// the whole reason this goes through parseGrabAmount and never parseFloat.

const NO_PROMO = MULTI_ITEM;        // merchantCharge '', promotion '-', totalDiscount '', adjustment ''
const WITH_PROMO = ITEM_DISCOUNT;   // promotion '67.500', totalDiscount '67.500'

test('every fare figure on a real order parses to minor units', () => {
  assert.deepEqual(normalizeOrderFare(detail(NO_PROMO), 0), {
    totalMinor: 548000,            // '548.000'
    subtotalMinor: 548000,         // '548.000'
    passengerTotalMinor: 580000,   // '580.000' — what the customer paid
    taxMinor: 0,                   // '0' — a real zero, not a sentinel
    deliveryFeeMinor: 32000,       // '32.000'
    commissionMinor: 134466,       // '134.466'
    merchantChargeMinor: null,     // ''
    smallOrderFeeMinor: 0,         // '0'
    promotionMinor: null,          // '-'
    totalDiscountMinor: null,      // ''
    reducedPriceMinor: 592000,     // '592.000'
    adjustmentByDriverMinor: null, // ''
    merchantChargeDisplay: '',
    promotionDisplay: '-',
    totalDiscountDisplay: '',
    adjustmentByDriverDisplay: '',
  });
});

test('every fare figure on every captured order is its display string with the grouping removed', () => {
  // The pinned test above is one order. This is all four × all twelve figures, and
  // it is the shape of the check rather than a table of expected numbers: a parsed
  // value must equal the digits Grab printed, and null must mean a sentinel — so a
  // regression that silently nulls a field, or drops a factor of 1000, fails here
  // even on a payload nobody wrote an assertion for.
  const FIELDS = [
    ['totalMinor', 'totalDisplay'],
    ['subtotalMinor', 'subTotalDisplay'],
    ['passengerTotalMinor', 'passengerTotalDisplay'],
    ['taxMinor', 'taxDisplay'],
    ['deliveryFeeMinor', 'deliveryFeeDisplay'],
    ['commissionMinor', 'mexCommissionDisplay'],
    ['merchantChargeMinor', 'merchantChargeDisplay'],
    ['smallOrderFeeMinor', 'smallOrderFeeDisplay'],
    ['promotionMinor', 'promotionDisplay'],
    ['totalDiscountMinor', 'totalDiscountAmountDisplay'],
    ['reducedPriceMinor', 'reducedPriceDisplay'],
    ['adjustmentByDriverMinor', 'adjustmentByDriverDisplay'],
  ] as const;

  assert.equal(details.length, 4);
  let checked = 0;
  for (const src of details) {
    const fare = normalizeOrderFare(src, 0) as unknown as Record<string, number | string | null>;
    for (const [minorKey, displayKey] of FIELDS) {
      const display = (src.fare as Record<string, unknown>)[displayKey];
      assert.equal(typeof display, 'string', `${src.orderID}.${displayKey} is a display STRING`);
      const where = `${src.orderID} ${displayKey}=${JSON.stringify(display)}`;
      if (display === '' || display === '-') {
        assert.equal(fare[minorKey], null, `${where} is a sentinel, so null and never 0`);
      } else {
        assert.equal(fare[minorKey], Number((display as string).replace(/[.,]/g, '')), where);
      }
      checked++;
    }
  }
  assert.equal(checked, 48);
});

test("the 1000x guard: '32.000' delivery fee in VND is 32000, not 32", () => {
  // parseFloat('32.000') is 32. Every fare figure below is one '.' away from being
  // wrong by three orders of magnitude, in the same direction, on every order.
  const src = detail(NO_PROMO);
  assert.equal(src.fare!.deliveryFeeDisplay, '32.000');
  assert.equal(normalizeOrderFare(src, 0).deliveryFeeMinor, 32000);
  assert.notEqual(normalizeOrderFare(src, 0).deliveryFeeMinor, 32);
  // And the commission, which is the figure an accountant would notice last.
  assert.equal(normalizeOrderFare(src, 0).commissionMinor, 134466);
});

test("'' and '-' are null and never 0, with the display string kept beside them", () => {
  // 0 is a real amount — "we charged you nothing" — and is indistinguishable from
  // "Grab sent its none sentinel" once it is in an integer column. taxDisplay is
  // '0' on this same order, so the two cases sit side by side in one payload.
  const fare = normalizeOrderFare(detail(NO_PROMO), 0);

  assert.equal(fare.merchantChargeMinor, null);
  assert.equal(fare.promotionMinor, null);
  assert.equal(fare.totalDiscountMinor, null);
  assert.equal(fare.adjustmentByDriverMinor, null);
  for (const v of [fare.merchantChargeMinor, fare.promotionMinor, fare.totalDiscountMinor, fare.adjustmentByDriverMinor]) {
    assert.notEqual(v, 0);
  }
  // The display columns are what tells a sentinel apart from a broken parse later.
  assert.deepEqual(
    [fare.merchantChargeDisplay, fare.promotionDisplay, fare.totalDiscountDisplay, fare.adjustmentByDriverDisplay],
    ['', '-', '', ''],
  );
  // Meanwhile a genuine zero stays a zero.
  assert.equal(fare.taxMinor, 0);
  assert.equal(fare.smallOrderFeeMinor, 0);
});

test('an order that DOES carry a promotion parses it rather than nulling it', () => {
  // The mirror of the test above: if '' -> null were implemented as "promotions are
  // always null", this is the order that would still pass it.
  const fare = normalizeOrderFare(detail(WITH_PROMO), 0);
  assert.equal(fare.promotionMinor, 67500);
  assert.equal(fare.promotionDisplay, '67.500');
  assert.equal(fare.totalDiscountMinor, 67500);
  assert.equal(fare.totalDiscountDisplay, '67.500');
  assert.equal(fare.passengerTotalMinor, 235500);
});

test('the exponent comes from the order, not from a constant', () => {
  // The same string is 32000 minor units at exponent 0 and 3200000 at exponent 2.
  // Nothing here may assume VND: the connector passes grabCurrencyExponent(statement).
  const src = detail(NO_PROMO);
  assert.equal(normalizeOrderFare(src, 0).deliveryFeeMinor, 32000);
  assert.equal(normalizeOrderFare(src, 2).deliveryFeeMinor, 3_200_000);
});

test('an unreadable fare figure is one null column, never a discarded order', () => {
  // A currency symbol appearing in one field is a format change, not a reason to
  // lose the other eleven figures — and detail_raw_json keeps the original string.
  const src = detail(NO_PROMO);
  src.fare!.totalDisplay = '₫548.000';
  src.fare!.taxDisplay = '0.0000'; // a rate-shaped string, which parseGrabAmount refuses

  const fare = normalizeOrderFare(src, 0);
  assert.equal(fare.totalMinor, null);
  assert.equal(fare.taxMinor, null);
  assert.equal(fare.subtotalMinor, 548000, 'the rest of the breakdown survives');
  assert.equal(fare.passengerTotalMinor, 580000);
});

test('a refused fare string is reported, naming the field — a sentinel is not', () => {
  // totalDisplay, taxDisplay and the six others like them have no *_display column,
  // so their NULL is indistinguishable in the row from Grab's '' / '-' "none". A
  // format change on one of them would null out every order's total from that night
  // on, and the only trace would be a column that looks exactly like "not charged".
  // This callback is the difference between that and a log line the same night.
  const src = detail(NO_PROMO);
  src.fare!.totalDisplay = '₫548.000';
  src.fare!.taxDisplay = '0.0000';

  const reported: [string, string][] = [];
  normalizeOrderFare(src, 0, (field, display) => reported.push([field, display]));

  assert.deepEqual(reported, [['totalDisplay', '₫548.000'], ['taxDisplay', '0.0000']]);

  // The sentinels are NOT a format change — this same order carries four of them,
  // and reporting those would bury the one line that matters in nightly noise.
  const quiet: string[] = [];
  normalizeOrderFare(detail(NO_PROMO), 0, field => quiet.push(field));
  assert.deepEqual(quiet, []);
});

test('a field that stops being sent is reported too — absence nulls the column just the same', () => {
  // The likelier format change, and the one a "did it parse?" check misses entirely:
  // Grab renames or drops the key. All twelve are present as strings on all 104 live
  // orders captured (2026-08-01..05), so reporting absence costs nothing nightly.
  const src = detail(NO_PROMO);
  delete src.fare!.deliveryFeeDisplay;

  const reported: [string, string][] = [];
  const fare = normalizeOrderFare(src, 0, (field, display) => reported.push([field, display]));

  assert.equal(fare.deliveryFeeMinor, null);
  assert.deepEqual(reported, [['deliveryFeeDisplay', '(absent)']]);
  assert.equal(fare.totalMinor, 548000, 'the rest of the breakdown is untouched');
});

test('a *Display member that is not a string is NULL, never the raw value', () => {
  // The four *Display members are bound straight to TEXT columns, in the same
  // statement as the line items and the verbatim payload. An object there does not
  // spoil one column — better-sqlite3 rejects the statement and the whole detail
  // write rolls back (see repo.test.ts for that end to end), so the guard belongs
  // here, where the value is produced.
  //
  // The shape is not hypothetical: this same fare object already carries
  // chargeFeeDescription and serviceChargeFeeDescription as {en, vi, …} i18n
  // objects, so a figure gaining a localized label is a rename away.
  const src = detail(NO_PROMO);
  const i18n = { en: 'Merchant charge', vi: 'Phí người bán' };
  (src.fare as Record<string, unknown>).merchantChargeDisplay = i18n;
  (src.fare as Record<string, unknown>).promotionDisplay = ['67.500'];
  (src.fare as Record<string, unknown>).totalDiscountAmountDisplay = 67500;
  (src.fare as Record<string, unknown>).adjustmentByDriverDisplay = null;

  const fare = normalizeOrderFare(src, 0);

  assert.deepEqual(
    [fare.merchantChargeDisplay, fare.promotionDisplay, fare.totalDiscountDisplay, fare.adjustmentByDriverDisplay],
    [null, null, null, null],
  );
  // A number is not "nearly a string": storing 67500 in a column whose entire job is
  // to say whether Grab printed '' or '-' would answer that question wrongly, and a
  // one-element array is worse still — better-sqlite3 reads it as positional
  // parameters and stores '67.500' with no error at all.
  for (const v of Object.values(fare)) {
    assert.ok(v === null || typeof v === 'number' || typeof v === 'string', JSON.stringify(v));
  }
  // The parsed halves are NULL too, and the rest of the breakdown is untouched.
  assert.equal(fare.merchantChargeMinor, null);
  assert.equal(fare.promotionMinor, null);
  assert.equal(fare.totalMinor, 548000);
});

test('a non-string *Display is reported once, by the field that changed shape', () => {
  // Once, not twice: the amount and the display come off the same key through the
  // same typeof check, and this callback is the one nightly signal a format change
  // gets. Duplicating it per field is how the real line gets skimmed past.
  const src = detail(NO_PROMO);
  (src.fare as Record<string, unknown>).merchantChargeDisplay = { en: 'Merchant charge' };

  const reported: [string, string][] = [];
  normalizeOrderFare(src, 0, (field, display) => reported.push([field, display]));
  assert.deepEqual(reported, [['merchantChargeDisplay', '[object Object]']]);
});

test('an order with no fare object at all yields all-null, does not throw, and says so twelve times', () => {
  const src = detail(NO_PROMO);
  src.fare = undefined;

  const reported: string[] = [];
  const fare = normalizeOrderFare(src, 0, field => reported.push(field));

  assert.deepEqual(Object.values(fare), new Array(Object.keys(fare).length).fill(null));
  // Silence here would be the worst case of all: every money column NULL, and eight
  // of them with nothing in the row to distinguish that from "not charged".
  assert.equal(reported.length, 12);
  assert.ok(reported.includes('totalDisplay') && reported.includes('mexCommissionDisplay'));
});

test('a non-string display on a line or a modifier is nulled, not passed to the driver', () => {
  // Same guard as the order-level *Display members, two levels down. These bind to
  // order_items.base_total_display and order_item_modifiers.price_display (TEXT, the
  // latter NOT NULL) inside replaceOrderItems' transaction, so an object here costs
  // the order's lines AND the verbatim payload the raw columns exist to keep — and
  // a one-element array is quieter still, stored as its first element with no error.
  const src = detail(MULTI_ITEM);
  const first = src.itemInfo!.items![0] as Record<string, any>;
  first.fare.originalItemPriceDisplay = { en: 'Base price', vi: 'Giá gốc' };
  first.modifierGroups[0].modifiers[0].priceDisplay = ['5.000'];

  const { items } = normalizeOrderItems(src, src.orderID, 0);

  assert.equal(items[0].baseTotalDisplay, null);
  // null, not '': '' is Grab's "printed nothing" sentinel, so coercing into it would
  // hide the format change inside the one value the tripwire query excludes.
  assert.equal(items[0].modifiers[0].priceDisplay, null);
  // Every value that reaches a column is bindable: no objects, no arrays.
  for (const item of items) {
    for (const v of [item.baseTotalDisplay, ...item.modifiers.map(m => m.priceDisplay)]) {
      assert.ok(v === null || typeof v === 'string', JSON.stringify(v));
    }
    for (const q of item.modifiers.map(m => m.quantity)) {
      assert.ok(q === null || Number.isSafeInteger(q), JSON.stringify(q));
    }
  }
  // The parsed halves go NULL with them, and the untouched lines are unaffected.
  assert.equal(items[0].baseTotalMinor, null);
  assert.equal(items[0].modifiers[0].priceMinor, null);
  assert.equal(typeof items[1].baseTotalDisplay, 'string');
});

test('a modifier quantity that is not a count is NULL, not a guessed 1', () => {
  // Absent legitimately means 1 — Grab omits it for single-selection groups — so the
  // two cases must not collapse onto the same stored value, or a format change on
  // this field is indistinguishable from every ordinary modifier in the table.
  const src = detail(MULTI_ITEM);
  const mods = (src.itemInfo!.items![0] as Record<string, any>).modifierGroups[0].modifiers;
  delete mods[0].quantity;
  mods[1] ??= { ...mods[0] };
  mods[1].quantity = { en: 'two' };

  const { items } = normalizeOrderItems(src, src.orderID, 0);

  assert.equal(items[0].modifiers[0].quantity, 1);
  assert.equal(items[0].modifiers[1].quantity, null);
});
