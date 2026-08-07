import { OrderFare, OrderItem, OrderItemDiscount, OrderItemModifier, UnifiedOrder } from '../../core/types.js';
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

  // No `?? 0` and no `?? 'VND'`. Both were plausible lies bound to a NOT NULL column:
  // 0 is a real earnings figure a cancelled order genuinely reports, and VND is one
  // country's currency on a platform that runs across SEA. Whatever the payload
  // carried is handed on as it is; core/order-guard.ts is what decides whether it can
  // be stored, and it names the order and the field when it cannot.
  const netMinor = statement.orderEarningsInMinorUnit;
  // `as string` rather than a fallback: the declared type is a claim about a remote
  // payload, and the `?.` is here so a missing currency object is a value this
  // normalizer hands on rather than a TypeError that costs the whole day's map.
  const currency = statement.currency?.code as string;

  return {
    platform: 'grab',
    // A fallback between two payload fields, not a type check: if `ID` arrives as an
    // object it is truthy and lands here whole. The guard is what catches that.
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

/**
 * The order-level money breakdown from a v3 detail payload.
 *
 * Grab reports every one of these as a display string, so every one goes through
 * parseGrabAmount against the order's OWN declared exponent — never a guess, and
 * never parseFloat (see money.ts). Nothing here throws: a fare figure we cannot
 * read is one NULL column, not a reason to discard the order's lines.
 *
 * null therefore carries two meanings, and both must stay distinct from 0: Grab's
 * '' / '-' "none" sentinels, and a string the parser refused. The four *Display
 * members are what separates them afterwards, and the whole fare object survives
 * verbatim in orders.detail_raw_json regardless.
 *
 * "Nothing here throws" has to hold one step further along than this function, too:
 * every member it returns is bound straight to a column, so every member is a
 * number, a string or null — never whatever shape the payload happened to carry.
 * See the `display` guard below for what that costs when it is missing.
 *
 * `onUnparsed` is how the second meaning gets said at all. Eight of the twelve
 * figures have no *Display companion, so a refusal leaves a NULL that reads exactly
 * like a sentinel — a format change on, say, totalDisplay would null out every
 * order's total from that night on with nothing in the row to show for it. Called
 * once per refused string, never for a sentinel; the connector logs it.
 */
export function normalizeOrderFare(
  order: GrabOrder,
  exponent: number,
  onUnparsed?: (field: string, display: string) => void,
): OrderFare {
  const fare = order.fare;
  // Keyed by field name rather than passed the value, so a refusal can name which
  // one changed shape — the whole point of reporting it.
  const amount = (field: string): number | null => {
    const display = fare?.[field];
    if (typeof display !== 'string') {
      // Absent counts as a refusal, and is reported like one. A renamed or dropped
      // key nulls the column exactly as a reformatted string does — silence for it
      // would leave the commonest format change of all with nothing to find. All 12
      // are present as strings on all 104 live orders captured (2026-08-01..05), so
      // this costs no nightly noise; a missing `fare` object reports all twelve.
      onUnparsed?.(field, display === undefined ? '(absent)' : String(display));
      return null;
    }
    try {
      return parseGrabAmount(display, exponent);
    } catch {
      onUnparsed?.(field, display);
      return null;
    }
  };

  // The same guard, for the four figures that also keep their raw string. The
  // declared `string | undefined` is a claim about a REMOTE payload, not a fact:
  // this very fare object already carries {en, vi, …} i18n objects
  // (chargeFeeDescription, serviceChargeFeeDescription), so the shape exists in the
  // response today and one rename is all it takes to land in one of these.
  //
  // Unguarded, the cost is not a bad column — it is the order's whole detail write.
  // These bind to TEXT columns in the same statement as the items and the verbatim
  // payload (repo.ts fareColumns), inside replaceOrderItems' transaction: an object
  // makes better-sqlite3 reject the statement ('Too few parameter values were
  // provided'), which rolls back the line items, every fare column AND
  // detail_raw_json — and because it is a DB error rather than the itemsSuspect
  // gate, not even rejected_detail_raw_json survives to show what arrived. An array
  // is quieter and worse: better-sqlite3 reads it as positional parameters, so a
  // one-element array is stored as its first element with no error at all
  // (reproduced both ways against a scratch database).
  //
  // Deliberately does NOT report: `amount` reads the same field through the same
  // typeof check and has already called onUnparsed for it. Saying it twice per
  // field would dilute the one signal a nightly format change gets.
  const display = (field: string): string | null => {
    const value = fare?.[field];
    return typeof value === 'string' ? value : null;
  };

  return {
    totalMinor: amount('totalDisplay'),
    subtotalMinor: amount('subTotalDisplay'),
    passengerTotalMinor: amount('passengerTotalDisplay'),
    taxMinor: amount('taxDisplay'),
    deliveryFeeMinor: amount('deliveryFeeDisplay'),
    commissionMinor: amount('mexCommissionDisplay'),
    merchantChargeMinor: amount('merchantChargeDisplay'),
    smallOrderFeeMinor: amount('smallOrderFeeDisplay'),
    promotionMinor: amount('promotionDisplay'),
    totalDiscountMinor: amount('totalDiscountAmountDisplay'),
    reducedPriceMinor: amount('reducedPriceDisplay'),
    adjustmentByDriverMinor: amount('adjustmentByDriverDisplay'),
    merchantChargeDisplay: display('merchantChargeDisplay'),
    promotionDisplay: display('promotionDisplay'),
    totalDiscountDisplay: display('totalDiscountAmountDisplay'),
    adjustmentByDriverDisplay: display('adjustmentByDriverDisplay'),
  };
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
        // Absent means 1 (Grab omits it for single-selection groups); anything that
        // is not a usable count is NULL, not a guessed 1 — the same rule the item
        // quantity above enforces by throwing, except a modifier is not worth losing
        // the line over.
        quantity: m.quantity === undefined || m.quantity === null
          ? 1
          : (Number.isSafeInteger(m.quantity) && (m.quantity as number) >= 0 ? m.quantity as number : null),
        priceMinor: optionalAmount(m.priceDisplay, exponent),
        // Same typeof guard as the order-level fare members: the declared type is a
        // claim about a remote payload, and a non-string here binds into a NOT NULL
        // TEXT column inside replaceOrderItems' transaction, taking the order's
        // lines and its verbatim payload down with it.
        // NULL, not '': '' is Grab's own "printed nothing" sentinel, so coercing a
        // malformed value into it hides a format change in the one value the
        // tripwire query excludes.
        priceDisplay: typeof m.priceDisplay === 'string' ? m.priceDisplay : null,
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
    baseTotalDisplay: typeof item.fare?.originalItemPriceDisplay === 'string'
      ? item.fare.originalItemPriceDisplay
      : null,
    // Any unparsed member poisons the sum: a too-small total is a confidently
    // wrong number, and line_total_minor is pre-discount so nothing contradicts it.
    discountMinor: discounts.length === 0 || discounts.some(d => d.amountMinor === null)
      ? null
      : discounts.reduce((n, d) => n + (d.amountMinor ?? 0), 0),
    comment: item.comment ?? null,
    position,
    modifiers,
    discounts,
    // The source object itself, untouched — no copy, no pick, no scrub. Everything
    // above is a projection of it, and the fields this normalizer does not know
    // about are the ones a future question will be about.
    rawJson: item,
  };
}

/**
 * A PER-LINE display string as minor units, or null when the parser refuses it.
 *
 * Swallowing the throw is defensible here because of what each of the three callers
 * does with the original: a modifier price keeps price_display, a line base keeps
 * base_total_display, and an item discount keeps amountDisplay inside discounts_json.
 * So a null that came from a format change stays separable from Grab's '' / '-'
 * "none" sentinel, and correcting the parser later is an UPDATE over stored strings
 * rather than a re-fetch of history the platform will not serve twice:
 *   WHERE price_minor IS NULL AND price_display NOT IN ('', '-')
 * Losing an entire order's lines over one unreadable modifier price would be the
 * worse trade — line_total_minor comes from an integer Grab sends outright and is
 * unaffected by any of this.
 *
 * normalizeOrderFare deliberately does NOT route through here. Eight of its twelve
 * figures have no companion column, so the same silence would leave nothing to find
 * afterwards — it reports every refusal to its caller instead.
 */
function optionalAmount(display: string | null | undefined, exponent: number): number | null {
  try {
    return parseGrabAmount(display, exponent);
  } catch {
    return null;
  }
}
