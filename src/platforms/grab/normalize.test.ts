import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeOrder } from './normalize.js';
import { GrabStatement } from './api.js';

const fixtures = JSON.parse(readFileSync(new URL('../../../data/sample-orders-for-mapping.json', import.meta.url), 'utf8'));
const orders: GrabStatement[] = fixtures.grab_orders;

const completed = orders.find(o => o.deliveryStatus === 'COMPLETED')!;
const executing = orders.find(o => o.deliveryStatus === 'ORDER_EXECUTING')!;

const norm = (s: GrabStatement) => normalizeOrder(s, 'acct-1', 'merch-1', 'Asia/Ho_Chi_Minh');

test('COMPLETED maps to completed', () => {
  assert.equal(norm(completed).status, 'completed');
  assert.equal(norm(completed).platformStatus, 'COMPLETED');
});

test('ORDER_EXECUTING maps to in_progress', () => {
  assert.equal(norm(executing).status, 'in_progress');
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
