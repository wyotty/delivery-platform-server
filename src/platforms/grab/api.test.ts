import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTzOffset } from './api.js';

test('IANA names map to offsets', () => {
  assert.equal(formatTzOffset('Asia/Ho_Chi_Minh'), '+07:00');
  assert.equal(formatTzOffset('Asia/Singapore'), '+08:00');
  assert.equal(formatTzOffset('UTC'), '+00:00');
});

test('raw offsets pass through', () => {
  assert.equal(formatTzOffset('+07:00'), '+07:00');
  assert.equal(formatTzOffset('-05:00'), '-05:00');
  assert.equal(formatTzOffset('+0800'), '+08:00'); // colon-less normalized
});

test('unrecognized timezone throws', () => {
  assert.throws(() => formatTzOffset('America/Nowhere'), /Unrecognized timezone/);
  assert.throws(() => formatTzOffset(''), /Unrecognized timezone/);
});
