import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnifiedOrder } from './types.js';
import { orderLabel, unstorableReason } from './order-guard.js';

// A real order's shape, from the live report. Every test below is this with one
// member replaced, so a test that passes for the wrong reason is impossible.
const order: UnifiedOrder = {
  platform: 'grab',
  platformOrderId: '001652323231-C8C3JTXZJGMTTJ',
  accountId: 'acct-1',
  merchantId: 'merch-1',
  status: 'completed',
  platformStatus: 'COMPLETED',
  grossAmountMinor: null,
  netAmountMinor: 548000,
  currency: 'VND',
  orderedAt: '2026-08-03T09:12:44Z',
  reportDate: '2026-08-03',
  platformTimezone: 'Asia/Ho_Chi_Minh',
  updatedAt: '2026-08-03T09:51:02.418733Z',
  rawJson: { ID: '001652323231-C8C3JTXZJGMTTJ' },
};

const withField = (field: string, value: unknown): UnifiedOrder =>
  ({ ...order, [field]: value }) as UnifiedOrder;

/**
 * The shapes a remote payload actually turns into, and what each one does when it is
 * bound to a column unguarded — measured against a scratch copy of this schema, not
 * assumed. The array rows are the reason this guard exists at all rather than a
 * try/catch: better-sqlite3 reads an array as positional parameters, so nothing
 * throws and nothing is logged.
 */
const BAD_TEXT: [string, unknown][] = [
  ['an i18n object', { en: 'COMPLETED', vi: 'HOÀN THÀNH' }], // this fare object already carries two
  ['a one-element array', ['COMPLETED']],                    // bound: stored as its first element, silently
  ['a number', 42],                                          // bound: stored as '42.0'
  ['null', null],
  ['undefined', undefined],                                  // what the removed `??` defaults used to hide
  ['an empty string', ''],
  ['a boolean', true],
];

const TEXT_FIELDS = ['platformOrderId', 'platformStatus', 'currency', 'orderedAt', 'updatedAt'];

test('a real order is storable, and so are its awkward-but-real values', () => {
  assert.equal(unstorableReason(order), null);

  // 0 earnings is a genuine cancelled order (1 of the 315 live statements surveyed),
  // not a missing value — the whole reason `?? 0` was indefensible.
  assert.equal(unstorableReason({ ...order, netAmountMinor: 0, status: 'cancelled' }), null);
  // Grab runs across SEA; nothing here may assume the currency that used to be
  // hardcoded, nor the exponent that makes these figures mean what they mean.
  assert.equal(unstorableReason({ ...order, currency: 'THB', netAmountMinor: 25_000 }), null);
  assert.equal(unstorableReason({ ...order, currency: 'SGD', netAmountMinor: 1_250 }), null);
  // A booking code, which is what normalizeOrder falls back to when a statement has
  // no ID. Shorter and shaped differently; still an identity.
  assert.equal(unstorableReason({ ...order, platformOrderId: 'A-9J73HL8GWNW6AV' }), null);
  // gross_amount_minor is the one nullable money column — Grab reports net only.
  assert.equal(unstorableReason({ ...order, grossAmountMinor: null }), null);
  // A status nobody has seen yet is still a status. This guard is about whether a
  // value can be READ, never about whether we recognize it.
  assert.equal(unstorableReason({ ...order, platformStatus: 'SOME_NEW_STATUS', status: 'other' }), null);
});

test('each of the five NOT NULL text fields refuses every shape a payload can arrive as', () => {
  let checked = 0;
  for (const field of TEXT_FIELDS) {
    for (const [label, value] of BAD_TEXT) {
      const reason = unstorableReason(withField(field, value));
      assert.ok(reason, `${field} accepted ${label}`);
      // Naming the field is the entire point: the error better-sqlite3 raised for
      // this ('You cannot specify named parameters in two different objects') named
      // neither the field nor the order, and the array case raised nothing at all.
      assert.ok(reason.startsWith(`${field} `), `${field} / ${label}: ${reason}`);
      checked++;
    }
  }
  assert.equal(checked, TEXT_FIELDS.length * BAD_TEXT.length);
});

test('netAmountMinor takes integers only — not the string that reads as one', () => {
  // '312.000' is how Grab prints three hundred and twelve thousand đồng. Bound to
  // this INTEGER column it stores 312, no error: the same 1000x error money.ts
  // exists to prevent, arriving through a different door.
  assert.match(unstorableReason(withField('netAmountMinor', '312.000'))!, /^netAmountMinor /);
  assert.match(unstorableReason(withField('netAmountMinor', '312000'))!, /^netAmountMinor /);
  // …and 'abc' would sit in the INTEGER column as text, where sum() reads it as 0.
  assert.match(unstorableReason(withField('netAmountMinor', 'abc'))!, /^netAmountMinor /);

  for (const value of [undefined, null, {}, [312000], 312.5, NaN, Infinity, true, 2 ** 53]) {
    assert.match(unstorableReason(withField('netAmountMinor', value))!, /^netAmountMinor /, String(value));
  }

  // Real figures, including the two that are easy to reject by accident.
  for (const value of [0, 1, 856000, -45000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(unstorableReason(withField('netAmountMinor', value)), null, String(value));
  }
});

test('an array is named an array, not an object — it is the shape that stores silently', () => {
  // `typeof []` is 'object', so a report that leant on typeof would describe the one
  // value better-sqlite3 accepts by the name of the one it rejects.
  assert.match(unstorableReason(withField('currency', ['THB']))!, /array \["THB"\]/);
  assert.match(unstorableReason(withField('netAmountMinor', [1]))!, /array \[1\]/);
  assert.match(unstorableReason(withField('platformStatus', { en: 'x' }))!, /object \{"en":"x"\}/);
  assert.match(unstorableReason(withField('orderedAt', undefined))!, /undefined/);
});

test('platformOrderId is checked first, and an empty one is worse than a missing one', () => {
  // ('grab','') is a perfectly good unique key: an empty id does not fail, it
  // COLLIDES, and the next id-less order updates this one's row. Two real orders
  // silently become one, and replaceOrderItems then writes one's lines onto it.
  assert.match(unstorableReason(withField('platformOrderId', ''))!, /^platformOrderId /);

  // First, so an order with several unreadable fields is reported by the one that
  // makes it unidentifiable rather than by whichever happens to be checked earliest.
  const wrecked = { ...order, platformOrderId: undefined, netAmountMinor: null, currency: 12 };
  assert.match(unstorableReason(wrecked as unknown as UnifiedOrder)!, /^platformOrderId /);
});

test('a failure names the order — and names it something usable when the id is what broke', () => {
  assert.equal(orderLabel(order), '001652323231-C8C3JTXZJGMTTJ');
  // The platform and its business day are one report to re-request. Without this the
  // operator gets 'undefined' and a count.
  assert.equal(orderLabel(withField('platformOrderId', { en: 'x' })), '(no id, grab/2026-08-03)');
  assert.equal(orderLabel(withField('platformOrderId', '')), '(no id, grab/2026-08-03)');
});

test('the reason is bounded — it shares one column and one chat line with two others', () => {
  // fetch_runs.error_message carries up to three of these. A whole payload pasted
  // into one buries the field name that is the actual diagnosis.
  const huge = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, 'x'.repeat(50)]));
  const reason = unstorableReason(withField('platformStatus', huge))!;
  assert.ok(reason.length < 160, `${reason.length} chars`);
  assert.ok(reason.startsWith('platformStatus is not a status string: object '));
  assert.ok(reason.endsWith('…'));
});

test('a value that cannot even be serialized is described, not thrown on', () => {
  // A guard that throws while reporting a bad order costs the batch it was added to
  // save. Circular objects and BigInts are both JSON.stringify hazards.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.match(unstorableReason(withField('currency', circular))!, /object \(unserializable\)/);
  assert.match(unstorableReason(withField('netAmountMinor', 10n))!, /^netAmountMinor /);
});
