import { OrderItem, OrderItemDiscount, OrderItemModifier, UnifiedOrder } from '../../core/types.js';
import { GrabOrder, GrabOrderItem, GrabStatement } from './api.js';
import { parseGrabAmount } from './money.js';

export function normalizeOrder(
  statement: GrabStatement,
  accountId: string,
  merchantId: string,
  platformTimezone: string,
  reportDate: string,
): UnifiedOrder {
  // Status mapping: cancelled is detected by cancelRole/cancelledAt, not by deliveryStatus
  const isCancelled = !!(statement.cancelRole || statement.cancelledAt);
  const status = isCancelled ? 'cancelled'
    : statement.deliveryStatus === 'COMPLETED' ? 'completed'
    : statement.deliveryStatus === 'FAILED' ? 'cancelled'
    : statement.deliveryStatus === 'ORDER_EXECUTING' ? 'in_progress'
    : 'other'; // unknown/new Grab statuses surface as 'other' (platformStatus keeps the raw value)

  const netMinor = statement.orderEarningsInMinorUnit ?? 0;
  const currency = statement.currency?.code ?? 'VND';

  return {
    platform: 'grab',
    platformOrderId: statement.ID || statement.bookingCode,
    accountId,
    merchantId,
    status,
    platformStatus: statement.deliveryStatus,
    // grossAmountMinor is null for Grab — it only provides net earnings
    grossAmountMinor: null,
    netAmountMinor: netMinor,
    currency,
    orderedAt: statement.createdAt,
    reportDate,
    platformTimezone,
    rawJson: statement,
    updatedAt: statement.updatedAt,
  };
}

export interface NormalizedOrderItems {
  items: OrderItem[];
  /** Set when the payload failed its own completeness checks — see UnifiedOrder.itemsSuspect. */
  suspect?: string;
}

/**
 * Line items and their modifiers from a v3 order-detail payload.
 *
 * Throws when the payload cannot be trusted at all (wrong order, no items, a line
 * with no total). The caller turns that into one order's itemsError; every other
 * order in the day is unaffected.
 */
export function normalizeOrderItems(
  order: GrabOrder,
  expectedOrderId: string,
  exponent: number,
): NormalizedOrderItems {
  if (order.orderID !== expectedOrderId) {
    // Writing one order's lines onto another is unrecoverable and invisible after
    // the fact — replaceOrderItems resolves the row from our own request, not from
    // the response, so nothing downstream would ever notice the swap.
    throw new Error(`Grab order detail mismatch: asked for ${expectedOrderId}, got ${order.orderID}`);
  }

  const raw = order.itemInfo?.items;
  if (!raw || raw.length === 0) {
    // Empty is never a legitimate answer: even a CANCELLED order carries its full
    // itemInfo (verified against a real cancellation). Fail so the stored rows live.
    throw new Error('Grab order detail returned no items');
  }

  const items = raw.map((item, position) => normalizeItem(item, position, exponent));

  // Completeness, integer against integer — no parsing inside the guard, because a
  // guard that can throw on a format change is worse than the truncation it checks
  // for. A 200 carrying 3 of 5 lines is otherwise indistinguishable from an edited
  // order that lost two, and replaceOrderItems deletes before it inserts.
  const reasons: string[] = [];
  // itemInfo.count counts UNITS, not lines: a single qty-2 line reports count 2.
  const declaredCount = order.itemInfo?.count;
  const units = items.reduce((n, i) => n + i.quantity, 0);
  if (typeof declaredCount === 'number' && declaredCount > 0 && declaredCount !== units) {
    reasons.push(`itemInfo.count ${declaredCount} != ${units} units`);
  }
  const sum = items.reduce((n, i) => n + i.lineTotalMinor, 0);
  const declaredTotal = order.fare?.originalPriceInMin;
  if (typeof declaredTotal === 'number' && sum !== declaredTotal) {
    reasons.push(`line totals ${sum} != fare.originalPriceInMin ${declaredTotal}`);
  }

  return reasons.length > 0 ? { items, suspect: reasons.join('; ') } : { items };
}

function normalizeItem(item: GrabOrderItem, position: number, exponent: number): OrderItem {
  // priceInMin is an integer, taken verbatim, and it is PER UNIT: it already
  // includes one unit's modifiers and precedes any item discount. The line total
  // is quantity * priceInMin — treating priceInMin as the line total undercounts
  // every multi-quantity line (7 of 43 real lines on an ordinary day).
  const unitPriceMinor = item.fare?.priceInMin;
  if (typeof unitPriceMinor !== 'number' || !Number.isSafeInteger(unitPriceMinor)) {
    throw new Error(`Grab item ${item.itemID ?? '(no id)'} has no usable fare.priceInMin`);
  }
  const quantity = item.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    // The line total is a product, so a junk quantity is not a small error.
    throw new Error(`Grab item ${item.itemID ?? '(no id)'} has an unusable quantity: ${item.quantity}`);
  }
  const lineTotalMinor = quantity * unitPriceMinor;
  if (!Number.isSafeInteger(lineTotalMinor)) {
    throw new Error(`Grab item ${item.itemID ?? '(no id)'} line total out of safe integer range`);
  }

  const modifiers: OrderItemModifier[] = [];
  for (const group of item.modifierGroups ?? []) {
    for (const m of group.modifiers ?? []) {
      modifiers.push({
        platformModifierId: m.modifierID ?? null,
        groupId: group.modifierGroupID ?? null,
        groupName: group.modifierGroupName ?? null,
        name: m.modifierName ?? '',
        quantity: m.quantity ?? 1,
        priceMinor: optionalAmount(m.priceDisplay, exponent),
        priceDisplay: m.priceDisplay ?? '',
        position: modifiers.length,
      });
    }
  }

  const discounts: OrderItemDiscount[] = (item.discountInfo ?? []).map(d => ({
    name: d.discountName ?? '',
    amountMinor: optionalAmount(d.itemDiscountPriceDisplay, exponent),
    amountDisplay: d.itemDiscountPriceDisplay ?? '',
    type: d.discountType ?? null,
    funding: d.discountFunding ?? null,
  }));

  const platformItemId = item.itemID ?? null;
  return {
    // The fallback keeps line_key NOT NULL and unique within the order, so the
    // unique index stays a real constraint even if Grab ever drops itemKey.
    lineKey: item.itemKey || `${platformItemId ?? 'item'}#${position}`,
    platformItemId,
    skuId: item.skuID ?? null,
    itemCode: item.itemCode ?? null,
    barcode: item.barcode ?? null,
    name: item.name ?? '',
    quantity,
    lineTotalMinor,
    unitPriceMinor,
    // Already line-scoped: originalItemPriceDisplay is the base times quantity.
    baseTotalMinor: optionalAmount(item.fare?.originalItemPriceDisplay, exponent),
    baseTotalDisplay: item.fare?.originalItemPriceDisplay ?? null,
    // Any unparsed member poisons the sum: a too-small total is a confidently
    // wrong number, and line_total_minor is pre-discount so nothing contradicts it.
    discountMinor: discounts.length === 0 || discounts.some(d => d.amountMinor === null)
      ? null
      : discounts.reduce((n, d) => n + (d.amountMinor ?? 0), 0),
    comment: item.comment ?? null,
    position,
    modifiers,
    discounts,
  };
}

/**
 * Modifier and discount amounts are informational — the money that matters is the
 * line total, an integer that already includes them. So an unrecognised display
 * string yields null rather than throwing away the whole order's lines; the raw
 * string is stored beside it, and every such row is findable in SQL later
 * (`price_minor IS NULL AND price_display NOT IN ('', '-')`) for a pure-SQL fix.
 */
function optionalAmount(display: string | null | undefined, exponent: number): number | null {
  try {
    return parseGrabAmount(display, exponent);
  } catch {
    return null;
  }
}
