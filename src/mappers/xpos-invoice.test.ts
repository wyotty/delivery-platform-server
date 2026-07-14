import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { InvoiceAction, InvoiceStatus, InvoiceType } from '@posx/core';
import { mapUnifiedOrderToInvoice, minorToMajor } from './xpos-invoice.js';
import { normalizeOrder } from '../platforms/grab/normalize.js';
import { UnifiedOrder } from '../core/types.js';
import { GrabStatement } from '../platforms/grab/api.js';

const samples = JSON.parse(
  readFileSync(new URL('../../data/sample-orders-for-mapping.json', import.meta.url), 'utf8'),
);

function makeOrder(overrides: Partial<UnifiedOrder> = {}): UnifiedOrder {
  return {
    platform: 'grab',
    platformOrderId: '001684995068-C8CACALARUMHPE',
    accountId: 'nguyenluu3108',
    merchantId: 'dong-day',
    status: 'completed',
    platformStatus: 'COMPLETED',
    grossAmountMinor: null,
    netAmountMinor: 312000,
    currency: 'VND',
    orderedAt: '2026-07-14T06:22:29Z',
    platformTimezone: 'Asia/Ho_Chi_Minh',
    updatedAt: '2026-07-14T06:40:13.122Z',
    rawJson: { some: 'payload' },
    ...overrides,
  };
}

test('minorToMajor: exponent 0 for VND and JPY', () => {
  assert.equal(minorToMajor(312000, 'VND'), 312000);
  assert.equal(minorToMajor(500, 'JPY'), 500);
});

test('minorToMajor: defaults to exponent 2 for other currencies', () => {
  assert.equal(minorToMajor(12345, 'USD'), 123.45);
});

test('minorToMajor: honours exponent overrides', () => {
  assert.equal(minorToMajor(12345, 'BHD', { BHD: 3 }), 12.345);
  assert.equal(minorToMajor(312000, 'VND', { VND: 2 }), 3120);
});

test('maps identity, type and action fields', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder());
  assert.equal(invoice.type, InvoiceType.Delivery);
  assert.equal(invoice.action, InvoiceAction.SettleOnlineDeliveryOrder);
  assert.equal(invoice.ref_id, '001684995068-C8CACALARUMHPE');
  assert.equal(invoice.delivery_type, 'grab');
});

test('maps completed -> Paid with paid_at from updatedAt', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder({ status: 'completed' }));
  assert.equal(invoice.status, InvoiceStatus.Paid);
  assert.deepEqual(invoice.paid_at, new Date('2026-07-14T06:40:13.122Z'));
  assert.deepEqual(invoice.voided_at, new Date(0));
});

for (const status of ['cancelled', 'refunded'] as const) {
  test(`maps ${status} -> Void with voided_at from updatedAt`, () => {
    const invoice = mapUnifiedOrderToInvoice(makeOrder({ status }));
    assert.equal(invoice.status, InvoiceStatus.Void);
    assert.deepEqual(invoice.voided_at, new Date('2026-07-14T06:40:13.122Z'));
    assert.deepEqual(invoice.paid_at, new Date(0));
  });
}

for (const status of ['in_progress', 'other'] as const) {
  test(`maps ${status} -> Open`, () => {
    const invoice = mapUnifiedOrderToInvoice(makeOrder({ status }));
    assert.equal(invoice.status, InvoiceStatus.Open);
    assert.deepEqual(invoice.paid_at, new Date(0));
    assert.deepEqual(invoice.voided_at, new Date(0));
  });
}

test('converts VND minor units 1:1 (exponent 0)', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder({ netAmountMinor: 312000 }));
  assert.equal(invoice.grand_total, 312000);
  assert.equal(invoice.subtotal, 312000);
});

test('converts 2-exponent currencies from cents to major units', () => {
  const invoice = mapUnifiedOrderToInvoice(
    makeOrder({ currency: 'USD', grossAmountMinor: 2050, netAmountMinor: 1899 }),
  );
  assert.equal(invoice.subtotal, 20.5);
  assert.equal(invoice.grand_total, 18.99);
  assert.equal(invoice.discount_amount, 1.51);
});

test('records the gross/net gap as an InvoiceDiscount so calculate() keeps it', () => {
  const invoice = mapUnifiedOrderToInvoice(
    makeOrder({ currency: 'USD', grossAmountMinor: 2050, netAmountMinor: 1899 }),
  );
  assert.equal(invoice.discounts.length, 1);
  assert.equal(invoice.discounts[0].amount, 1.51);
  assert.equal(invoice.discounts[0].name, 'grab platform commission');
});

test('leaves discounts empty when gross equals net or is null', () => {
  assert.equal(mapUnifiedOrderToInvoice(makeOrder()).discounts.length, 0);
  assert.equal(mapUnifiedOrderToInvoice(makeOrder({ grossAmountMinor: 312000 })).discounts.length, 0);
});

test('falls back to net for subtotal when gross is null', () => {
  const invoice = mapUnifiedOrderToInvoice(
    makeOrder({ grossAmountMinor: null, netAmountMinor: 52000 }),
  );
  assert.equal(invoice.subtotal, 52000);
  assert.equal(invoice.grand_total, 52000);
  assert.equal(invoice.discount_amount, 0);
});

test('honours currencyExponents option override', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder({ netAmountMinor: 312000 }), {
    currencyExponents: { VND: 2 },
  });
  assert.equal(invoice.grand_total, 3120);
  assert.equal(invoice.subtotal, 3120);
});

test('creates one synthetic line consistent with invoice totals', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder({ netAmountMinor: 52000 }));
  assert.equal(invoice.lines.length, 1);
  const line = invoice.lines[0];
  assert.match(line.uid, /^iln_/);
  assert.equal(line.item_uid, line.item.uid);
  assert.ok(line.item_uid);
  assert.equal(line.quantity, 1);
  assert.equal(line.price, 52000);
  assert.equal(line.subtotal, 52000);
  assert.equal(line.subtotal_before_discount, 52000);
  assert.equal(line.invoice_uid, invoice.uid);
  assert.equal(line.subtotal, invoice.subtotal);
  assert.equal(invoice.subtotal, invoice.grand_total);
});

test('stores provenance in meta including the raw payload', () => {
  const raw = { deliveryStatus: 'COMPLETED' };
  const invoice = mapUnifiedOrderToInvoice(makeOrder({ rawJson: raw }));
  assert.deepEqual(invoice.meta, {
    platform: 'grab',
    platform_order_id: '001684995068-C8CACALARUMHPE',
    account_id: 'nguyenluu3108',
    merchant_id: 'dong-day',
    platform_status: 'COMPLETED',
    raw,
  });
});

test('maps orderedAt -> created_at and updatedAt -> updated_at as Dates', () => {
  const invoice = mapUnifiedOrderToInvoice(makeOrder());
  assert.deepEqual(invoice.created_at, new Date('2026-07-14T06:22:29Z'));
  assert.equal(invoice.created_at_timestamp, new Date('2026-07-14T06:22:29Z').getTime());
  assert.deepEqual(invoice.updated_at, new Date('2026-07-14T06:40:13.122Z'));
});

test('end-to-end: normalizeOrder -> mapUnifiedOrderToInvoice for every real Grab sample', () => {
  assert.ok(samples.grab_orders.length > 0);
  for (const grab of samples.grab_orders as GrabStatement[]) {
    const unified = normalizeOrder(grab, 'grab-dong-day', 'dong-day', 'Asia/Ho_Chi_Minh');
    const invoice = mapUnifiedOrderToInvoice(unified);

    assert.equal(invoice.type, InvoiceType.Delivery);
    assert.equal(invoice.delivery_type, 'grab');
    assert.equal(invoice.ref_id, grab.ID);
    // VND exponent 0: minor units map 1:1 to major units
    assert.equal(invoice.grand_total, grab.orderEarningsInMinorUnit);
    assert.equal(invoice.subtotal, invoice.grand_total);
    assert.equal(invoice.lines[0].subtotal, invoice.subtotal);
    assert.deepEqual(invoice.created_at, new Date(grab.createdAt));
    assert.deepEqual(invoice.updated_at, new Date(grab.updatedAt));
    assert.equal(invoice.meta.platform_status, grab.deliveryStatus);
    assert.equal(invoice.meta.raw, grab);

    if (grab.deliveryStatus === 'COMPLETED') {
      assert.equal(invoice.status, InvoiceStatus.Paid);
      assert.deepEqual(invoice.paid_at, new Date(grab.updatedAt));
    } else if (grab.deliveryStatus === 'ORDER_EXECUTING') {
      assert.equal(invoice.status, InvoiceStatus.Open);
    } else {
      assert.equal(invoice.status, InvoiceStatus.Void);
    }
  }
});

test('sample set covers COMPLETED and ORDER_EXECUTING statuses', () => {
  const statuses = samples.grab_orders.map((o: GrabStatement) => o.deliveryStatus);
  assert.ok(statuses.includes('COMPLETED'));
  assert.ok(statuses.includes('ORDER_EXECUTING'));
});
