import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eachDate, yesterdayIn, assertBusinessDate } from './dates.js';

test('eachDate expands an inclusive range', () => {
  assert.deepEqual(eachDate('2026-07-25', '2026-07-27'), ['2026-07-25', '2026-07-26', '2026-07-27']);
});

test('eachDate returns a single date when from === to', () => {
  assert.deepEqual(eachDate('2026-07-26', '2026-07-26'), ['2026-07-26']);
});

test('eachDate crosses month and year boundaries', () => {
  assert.deepEqual(eachDate('2026-01-31', '2026-02-01'), ['2026-01-31', '2026-02-01']);
  assert.deepEqual(eachDate('2025-12-31', '2026-01-01'), ['2025-12-31', '2026-01-01']);
});

test('eachDate handles a leap day', () => {
  assert.deepEqual(eachDate('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
});

test('eachDate rejects a reversed range instead of silently returning nothing', () => {
  assert.throws(() => eachDate('2026-07-27', '2026-07-25'), /is after/);
});

test('assertBusinessDate rejects non-date strings', () => {
  assert.throws(() => assertBusinessDate('2026-7-5'), /YYYY-MM-DD/);
  assert.throws(() => assertBusinessDate('2026-07-26T00:00:00Z'), /YYYY-MM-DD/);
});

test('yesterdayIn resolves in the merchant timezone, not the host timezone', () => {
  // 2026-07-27T00:30:00Z is still 2026-07-26 in UTC-terms for a UTC host,
  // but already 07:30 on 07-27 in Ho Chi Minh (+07:00) — so "yesterday" differs.
  const at = new Date('2026-07-27T00:30:00Z');
  assert.equal(yesterdayIn('Asia/Ho_Chi_Minh', at), '2026-07-26');
  assert.equal(yesterdayIn('UTC', at), '2026-07-26');
});

test('yesterdayIn crosses a month boundary', () => {
  assert.equal(yesterdayIn('Asia/Ho_Chi_Minh', new Date('2026-08-01T05:00:00Z')), '2026-07-31');
});
