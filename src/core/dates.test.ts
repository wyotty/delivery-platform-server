import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eachDate, dateInTz, assertBusinessDate } from './dates.js';

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

test('dateInTz resolves the calendar day in the merchant timezone, not the host timezone', () => {
  // 00:30Z is still 07-26 for a UTC host, but already 07:30 on 07-27 in Ho Chi Minh (+07:00).
  const at = new Date('2026-07-27T00:30:00Z');
  assert.equal(dateInTz(at, 'Asia/Ho_Chi_Minh'), '2026-07-27');
  assert.equal(dateInTz(at, 'UTC'), '2026-07-27');

  // 18:30Z is still 07-25 in UTC, but 01:30 on 07-26 in Ho Chi Minh.
  const evening = new Date('2026-07-25T18:30:00Z');
  assert.equal(dateInTz(evening, 'Asia/Ho_Chi_Minh'), '2026-07-26');
  assert.equal(dateInTz(evening, 'UTC'), '2026-07-25');
});

test('dateInTz crosses a month boundary', () => {
  assert.equal(dateInTz(new Date('2026-07-31T18:00:00Z'), 'Asia/Ho_Chi_Minh'), '2026-08-01');
});
