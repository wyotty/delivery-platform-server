import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGrabAmount, grabCurrencyExponent } from './money.js';
import { GrabStatement } from './api.js';

const statements: GrabStatement[] = JSON.parse(
  readFileSync(new URL('../../../data/sample-orders-for-mapping.json', import.meta.url), 'utf8'),
).grab_orders;

const details = JSON.parse(
  readFileSync(new URL('../../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders;

// ===== VND (exponent 0) — the case that actually ships =====

test('display string parses to the integer Grab itself reports for it', () => {
  // Every statement carries both forms of the same number. Six real pairs, so the
  // '.' -> 1000x bug cannot pass: parseFloat('312.000') is 312, not 312000.
  assert.equal(statements.length, 6);
  for (const s of statements) {
    assert.equal(parseGrabAmount(s.priceDisplay, 0), s.orderEarningsInMinorUnit, s.priceDisplay);
  }
});

test('the shapes that appear on order lines', () => {
  assert.equal(parseGrabAmount('169.000', 0), 169000); // fare.priceDisplay
  assert.equal(parseGrabAmount('0', 0), 0);            // a free modifier — 0, never null
  assert.equal(parseGrabAmount('67.500', 0), 67500);   // itemDiscountPriceDisplay
  assert.equal(parseGrabAmount('5.000', 0), 5000);     // the classic 1000x trap
  assert.equal(parseGrabAmount('1.234.000', 0), 1234000);
  assert.equal(parseGrabAmount('300.768', 0), 300768); // fare.reducedPriceDisplay
});

test("'' and '-' are Grab's two sentinels for none, and mean null not 0", () => {
  // 0 would be a real amount. Both strings are real: merchantChargeDisplay is '',
  // promotionDisplay is '-' on an order with no promo.
  assert.equal(parseGrabAmount('', 0), null);
  assert.equal(parseGrabAmount('-', 0), null);
  assert.equal(parseGrabAmount(null, 0), null);
  assert.equal(parseGrabAmount(undefined, 0), null);
});

test('a rate is not money — taxRate\'s real value is rejected, not read as 0', () => {
  // fare.taxRate is the literal string '0.0000' on every captured order. Four
  // digits after the separator is neither a VND group nor a sentinel.
  const taxRate = details[0].fare.taxRate;
  assert.equal(taxRate, '0.0000');
  assert.throws(() => parseGrabAmount(taxRate, 0), /Unparseable/);
});

test('anything unrecognised throws rather than guessing', () => {
  assert.throws(() => parseGrabAmount('₫169.000', 0), /Unparseable/); // symbol attached
  assert.throws(() => parseGrabAmount('1234.5678', 0), /Unparseable/);
  assert.throws(() => parseGrabAmount('n/a', 0), /Unparseable/);
});

test('whitespace, including non-breaking, is stripped', () => {
  assert.equal(parseGrabAmount(' 169.000 ', 0), 169000);
  assert.equal(parseGrabAmount('169 000', 0), 169000);
});

test('negative amounts keep their sign', () => {
  assert.equal(parseGrabAmount('-22.500', 0), -22500);
});

// ===== Decimal currencies (exponent 2) =====
// This merchant is GrabFood Vietnam, so no non-zero-exponent payload was ever
// captured. These inputs are constructed — the parser is exercised, the strings
// are not evidence of Grab's SGD/MYR formatting.

test('exponent 2: the last separator is a decimal point when it has 2 digits after it', () => {
  assert.equal(parseGrabAmount('1,234.56', 2), 123456);
  assert.equal(parseGrabAmount('169.00', 2), 16900);
  assert.equal(parseGrabAmount('0.05', 2), 5);
});

test('exponent 2: no separator at all is a whole major unit', () => {
  assert.equal(parseGrabAmount('169', 2), 16900);
  assert.equal(parseGrabAmount('0', 2), 0);
});

test('exponent 2: 3 digits after the last separator is grouping, not a fraction', () => {
  // '1.234' in a 2-decimal currency cannot be 1.234 units — it is one thousand
  // two hundred thirty four.
  assert.equal(parseGrabAmount('1.234', 2), 123400);
});

test('exponent 2: 1 digit after the separator is ambiguous and refused', () => {
  // Neither the exponent nor a group of 3. Picking either would be a 10x error.
  assert.throws(() => parseGrabAmount('1.2', 2), /Ambiguous/);
});

// ===== Exponent resolution =====

test('the statement\'s own exponent wins', () => {
  assert.equal(statements[0].currency.exponent, '0');
  assert.equal(grabCurrencyExponent(statements[0]), 0);
  assert.equal(grabCurrencyExponent(withCurrency({ code: 'SGD', exponent: '2' })), 2);
});

test('an empty exponent string falls through to the ISO table, it does not read as 0', () => {
  // Number('') is 0, so a blank field would silently make SGD zero-decimal — a
  // 100x error on every row of a currency this code has never seen.
  assert.equal(grabCurrencyExponent(withCurrency({ code: 'SGD', exponent: '' })), 2);
  assert.equal(grabCurrencyExponent(withCurrency({ code: 'VND', exponent: '' })), 0);
});

test('an unknown currency throws — there is deliberately no default of 2', () => {
  assert.throws(
    () => grabCurrencyExponent(withCurrency({ code: 'XYZ', exponent: '' })),
    /Cannot determine minor-unit exponent/,
  );
});

function withCurrency(currency: { code: string; exponent: string }): GrabStatement {
  return {
    ...statements[0],
    currency: { ...statements[0].currency, ...currency },
  };
}
