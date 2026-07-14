import {
  Invoice,
  InvoiceAction,
  InvoiceDiscount,
  InvoiceLine,
  InvoiceStatus,
  InvoiceType,
  ModelPrefix,
} from '@posx/core';
import { nanoid } from 'nanoid';
import { UnifiedOrder } from '../core/types.js';

/** Options for {@link mapUnifiedOrderToInvoice}. */
export interface MapUnifiedOrderOptions {
  /**
   * Currency-code -> minor-unit exponent overrides, merged over the defaults
   * (VND=0, JPY=0, anything else 2). E.g. `{ BHD: 3 }`.
   */
  currencyExponents?: Record<string, number>;
}

/** ISO 4217 minor-unit exponents that differ from the default of 2. */
const DEFAULT_CURRENCY_EXPONENTS: Record<string, number> = {
  VND: 0,
  JPY: 0,
};

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/**
 * Converts a minor-unit amount to major decimal units (the unit convention
 * used by all Invoice money fields in @posx/core).
 *
 * @param amountMinor amount in minor units (e.g. cents, or whole VND)
 * @param currency ISO 4217 currency code
 * @param exponentOverrides optional currency -> exponent overrides
 * @returns amount in major units, rounded to the currency's precision
 *   (at least 2 decimal places, so 3-exponent currencies keep full precision)
 */
export function minorToMajor(
  amountMinor: number,
  currency: string,
  exponentOverrides?: Record<string, number>,
): number {
  const exponent =
    exponentOverrides?.[currency] ??
    DEFAULT_CURRENCY_EXPONENTS[currency] ??
    2;
  return round(amountMinor / Math.pow(10, exponent), Math.max(2, exponent));
}

/**
 * Maps a {@link UnifiedOrder} to a @posx/core {@link Invoice}.
 *
 * Mapping decisions (see docs/xpos-invoice-mapping.md for the full tables):
 * - `type` = `InvoiceType.Delivery`, `delivery_type` = `order.platform`,
 *   `ref_id` = `order.platformOrderId`,
 *   `action` = `InvoiceAction.SettleOnlineDeliveryOrder`.
 * - status: `completed` -> `Paid` (`paid_at` = updatedAt);
 *   `cancelled`/`refunded` -> `Void` (`voided_at` = updatedAt);
 *   `in_progress`/`other` -> `Open`.
 * - money: UnifiedOrder amounts are minor units; Invoice amounts are major
 *   decimal units, converted via {@link minorToMajor}. `subtotal` comes from
 *   `grossAmountMinor`, falling back to `netAmountMinor` when gross is null.
 *   `grand_total` always comes from `netAmountMinor`; any gross/net gap
 *   (platform commission) is recorded as a flat `InvoiceDiscount` in
 *   `discounts` (and mirrored in `discount_amount`) so it survives
 *   `InvoiceService.calculate()`, which rederives `discount_amount` from
 *   `discounts`.
 * - lines: platforms provide no line items, so one synthetic `InvoiceLine`
 *   carries the order subtotal (qty 1, price = subtotal).
 * - provenance: platform, platformOrderId, accountId, merchantId,
 *   platformStatus and the raw payload are stored in `meta`.
 * - dates: `orderedAt` -> `created_at`, `updatedAt` -> `updated_at`.
 *
 * @param order normalized delivery order
 * @param options optional mapping options (currency exponent overrides)
 * @returns a new Invoice populated from the order
 */
export function mapUnifiedOrderToInvoice(
  order: UnifiedOrder,
  options?: MapUnifiedOrderOptions,
): Invoice {
  const exponents = options?.currencyExponents;
  const grandTotal = minorToMajor(order.netAmountMinor, order.currency, exponents);
  const subtotal = minorToMajor(
    // ponytail: null gross = unknown, fall back to net so totals stay consistent
    order.grossAmountMinor ?? order.netAmountMinor,
    order.currency,
    exponents,
  );

  const invoice = new Invoice();
  invoice.type = InvoiceType.Delivery;
  invoice.action = InvoiceAction.SettleOnlineDeliveryOrder;
  invoice.ref_id = order.platformOrderId;
  invoice.delivery_type = order.platform;

  invoice.created_at = new Date(order.orderedAt);
  invoice.created_at_timestamp = invoice.created_at.getTime();
  invoice.updated_at = new Date(order.updatedAt);

  switch (order.status) {
    case 'completed':
      invoice.status = InvoiceStatus.Paid;
      invoice.paid_at = new Date(order.updatedAt);
      break;
    case 'cancelled':
    case 'refunded':
      invoice.status = InvoiceStatus.Void;
      invoice.voided_at = new Date(order.updatedAt);
      break;
    default: // in_progress | other
      invoice.status = InvoiceStatus.Open;
  }

  const line = new InvoiceLine();
  line.uid = ModelPrefix.InvoiceLine + nanoid();
  line.invoice_uid = invoice.uid;
  line.item.name = `${order.platform} order ${order.platformOrderId}`;
  line.item_uid = line.item.uid;
  line.quantity = 1;
  line.price = subtotal;
  line.item.price = subtotal;
  line.subtotal = subtotal;
  line.subtotal_before_discount = subtotal;
  invoice.lines = [line];

  invoice.subtotal = subtotal;
  invoice.discountable_subtotal = subtotal;
  const gap = round(Math.max(subtotal - grandTotal, 0), 2);
  if (gap > 0) {
    // Push a real InvoiceDiscount so InvoiceService.calculate() (which resets
    // discount_amount and rederives it from invoice.discounts) keeps the gap.
    const discount = new InvoiceDiscount();
    discount.amount = gap;
    discount.name = `${order.platform} platform commission`;
    invoice.discounts = [discount];
  }
  invoice.discount_amount = gap;
  invoice.grand_total = grandTotal;

  invoice.meta = {
    platform: order.platform,
    platform_order_id: order.platformOrderId,
    account_id: order.accountId,
    merchant_id: order.merchantId,
    platform_status: order.platformStatus,
    raw: order.rawJson,
  };

  return invoice;
}
