import { UnifiedOrder } from './types.js';

/**
 * The last check before a UnifiedOrder becomes rows: can this order be stored at all?
 *
 * Six of its members are read off a REMOTE payload and bound to a NOT NULL column
 * (orders.platform_order_id, platform_status, net_amount_minor, currency, ordered_at,
 * updated_at — and currency again, denormalized into every order_items row). Their
 * TypeScript types are claims about that payload, not facts about it, and nothing
 * downstream turns one into the other:
 *
 *   - SQLite is dynamically typed. A column type is an AFFINITY, not a constraint,
 *     and NOT NULL rejects NULL and nothing else. Bound straight into this schema on
 *     a scratch copy of it: net_amount_minor '312.000' stores 312 — the exact 1000x
 *     error money.ts exists to prevent, arriving through a different door — 'abc'
 *     stores the text 'abc' in an INTEGER column where sum() reads it as 0, and
 *     currency 704 stores '704.0', a currency nobody uses, on a row whose every
 *     amount is read against it.
 *   - better-sqlite3 reads an ARRAY as positional parameters, so a one-element array
 *     is stored as its first element with NO error at all: currency ['THB'] lands as
 *     'THB'. Quiet and wrong is the worst outcome on offer here.
 *   - The shapes it does reject ({en,vi} i18n objects, longer arrays) throw from
 *     inside upsertOrders' phase-1 transaction, which used to take the whole batch
 *     with them: reproduced on a 3-order batch carrying one object-valued
 *     deliveryStatus — 0 of 3 orders stored, the items phase never reached, and an
 *     error naming neither the order nor the field ('You cannot specify named
 *     parameters in two different objects').
 *
 * So the rule is: a value that cannot be READ costs its own order and nothing else.
 *
 * Fatal rather than defaulted, for all six. A NOT NULL column has no NULL to record
 * "we do not know", so every default available here is a plausible lie in a column
 * nothing else in the row contradicts — the same reasoning the item and fare
 * normalizers already follow one level down (null is never 0), spelled differently
 * because NULL is not on offer. Two such lies were already being told, and this is
 * what replaces them: see netAmountMinor and currency below.
 *
 * All six are present and well-formed on all 315 live statements surveyed
 * (2026-07-24..08-06, two delivery statuses, one of them a real cancellation). So
 * rejecting costs nothing nightly — it is the alarm for the night Grab changes a
 * shape, and the order it rejects is named, reported per order, and re-tried by the
 * next trailing pass.
 */
export function unstorableReason(order: UnifiedOrder): string | null {
  // Checked first because it is the row's identity: the unique index upsertOrder
  // conflicts on, and the WHERE replaceOrderItems resolves an order's lines through.
  // There is no value to invent, and '' is worse than a missing one — ('grab','') is
  // a perfectly good unique key, so the next id-less order UPDATES this one and two
  // real orders silently become one row.
  if (!isText(order.platformOrderId)) {
    return `platformOrderId is not a usable order id: ${describe(order.platformOrderId)}`;
  }

  // The RAW platform status, which is what a later re-evaluation of the normalized
  // `status` reads. `status` already has an honest 'other' for a value we do not
  // recognize; this column has no equivalent, and '' would assert that the platform
  // reported no status at all — a claim about Grab that Grab never made.
  if (!isText(order.platformStatus)) {
    return `platformStatus is not a status string: ${describe(order.platformStatus)}`;
  }

  // Replaces `?? 0`, the most expensive of the defaults this guard removes: 0 is a
  // REAL earnings figure that a cancelled order genuinely reports (1 of the 315
  // statements surveyed), getSummary sums this column, and an invented zero
  // understates a day's takings with nothing in the row to contradict it.
  //
  // Not coerced either. Number('312.000') is 312, so accepting a numeric-looking
  // string is a 1000x error in the same direction on every VND order. isSafeInteger
  // also rejects the JSON.rawJSON wrapper parseJsonLossless produces for an int64,
  // which is right: a value we could not represent must not be summed.
  if (!Number.isSafeInteger(order.netAmountMinor)) {
    return `netAmountMinor is not a minor-unit integer: ${describe(order.netAmountMinor)}`;
  }

  // Replaces `?? 'VND'`, which hardcoded one country's currency for a platform that
  // operates across SEA. On a THB order that default makes every amount in this row —
  // and in every order_items row it is denormalized into — read ~800x wrong, and
  // there is nothing else on the order to recover the real code from.
  if (!isText(order.currency)) {
    return `currency is not a currency code: ${describe(order.currency)}`;
  }

  // The timestamps. Fabricating one (Date.now(), '') forges a record: ordered_at is
  // what "when did customers actually order" is answered from and what listOrders
  // sorts on, and updated_at is the platform's own account of when it last touched
  // the order. A made-up value is indistinguishable from a real one forever after.
  if (!isText(order.orderedAt)) {
    return `orderedAt is not a timestamp: ${describe(order.orderedAt)}`;
  }
  if (!isText(order.updatedAt)) {
    return `updatedAt is not a timestamp: ${describe(order.updatedAt)}`;
  }

  // Deliberately NOT shape checks. An ISO 8601 or ISO 4217 regex would reject a real
  // order over a guess about a format we do not control, which costs exactly the
  // order this guard exists to save. Readable-but-odd is stored, verbatim, with
  // raw_json beside it; unreadable is not.
  return null;
}

/**
 * How a failure names an order — including when the order's own id is what broke.
 *
 * The platform and its business day are what is left to find it by: that is one
 * report to re-request, and the structured log line carries the whole list.
 */
export function orderLabel(order: UnifiedOrder): string {
  return isText(order.platformOrderId)
    ? order.platformOrderId
    : `(no id, ${order.platform}/${order.reportDate})`;
}

/** A value that can be bound to a NOT NULL TEXT column and still mean something. */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * A rejected value, said out loud. The kind matters as much as the text — 'array' is
 * spelled out because `typeof []` is 'object' and an array is the one shape
 * better-sqlite3 does not reject.
 */
function describe(value: unknown): string {
  // These two say everything about themselves; the kind prefix below would stutter
  // ('undefined undefined'), and `undefined` is what a removed `??` default leaves.
  if (value === null || value === undefined) return String(value);
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // Circular, or a BigInt. The kind below is the diagnosis in either case.
    text = '(unserializable)';
  }
  const kind = Array.isArray(value) ? 'array' : typeof value;
  // Bounded: this ends up in fetch_runs.error_message and a chat alert, alongside up
  // to two more of its kind. A whole i18n object pasted in there buries the field name.
  return `${kind} ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}
