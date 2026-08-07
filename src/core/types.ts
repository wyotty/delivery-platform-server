// src/core/types.ts
import type { Logger } from 'pino';
import type { StoredOrderDetail } from './detail-refresh.js';

export type PlatformName = string; // 'grab' | 'foodpanda' | ... (open-ended)

export type OrderStatus = 'completed' | 'cancelled' | 'refunded' | 'in_progress' | 'other';

/** Business dates in the merchant's local timezone — strings to avoid UTC confusion */
export interface DateRange {
  from: string; // 'YYYY-MM-DD'
  to: string;   // 'YYYY-MM-DD'
}

export interface PlatformAccount {
  id: string;
  platform: PlatformName;
  merchantId: string;
  merchantName: string;
  credentials: Record<string, string>; // opaque per-platform; stored encrypted in DB
  timezone: string; // IANA timezone name (e.g. 'Asia/Ho_Chi_Minh')
  config: Record<string, unknown>;
}

/** One modifier/option chosen on an order line. */
export interface OrderItemModifier {
  /** The platform's catalog id (Grab: modifierID) — not a SKU; Grab has none on modifiers. */
  platformModifierId: string | null;
  groupId: string | null;
  groupName: string | null;
  name: string;
  /** 1 when the platform omits it; null when it sent something that is not a count. */
  quantity: number | null;
  /**
   * Price delta in minor units. null means the platform's string did not parse —
   * never 0, which is indistinguishable from a genuinely free option. Every such
   * row is findable later: `price_minor IS NULL AND price_display NOT IN ('', '-')`.
   */
  priceMinor: number | null;
  /**
   * The platform's raw price string, kept so a parser fix is a SQL job, not a
   * re-fetch. null when the platform sent a non-string — NOT '', which is Grab's
   * own "printed nothing" sentinel and the value the tripwire query excludes.
   */
  priceDisplay: string | null;
  /** 0-based index within this line's flattened modifier list. */
  position: number;
}

/** A discount applied to a single line (not to the order). */
export interface OrderItemDiscount {
  name: string;
  /**
   * The amount taken OFF the line, in minor units. Grab names its field
   * `itemDiscountPriceDisplay`, which reads like the discounted price — it is not:
   * 67.500 on a 135.000 line under a promo named "GIẢM 50%".
   */
  amountMinor: number | null;
  /** Raw platform string, kept for the same reason as OrderItemModifier.priceDisplay. */
  amountDisplay: string;
  type: string | null;
  funding: string | null;
}

export interface OrderItem {
  /** Stable per-line key from the platform (Grab: itemKey). Unique within the order. */
  lineKey: string;
  /** The platform's catalog id (Grab: itemID). NOT the merchant's SKU. */
  platformItemId: string | null;
  /** Merchant-supplied ids. Always '' on GrabFood — nothing may depend on these. */
  skuId: string | null;
  itemCode: string | null;
  barcode: string | null;
  name: string;
  quantity: number;
  /**
   * What the whole line came to, in minor units: quantity × unitPriceMinor.
   * Includes modifiers, precedes item discounts. This is the figure to sum —
   * Σ over an order's lines is exactly the platform's own order total.
   */
  lineTotalMinor: number;
  /**
   * ONE unit, including that unit's modifiers (Grab: fare.priceInMin, verbatim).
   * Verified per-unit against 7 real quantity>1 lines: a qty-2 line reports
   * priceInMin 69000 on a 138000 line.
   */
  unitPriceMinor: number;
  /**
   * The line's base before modifiers — already scaled by quantity, unlike
   * unitPriceMinor. Nullable: parsed from a display string, so null means "did
   * not parse", never 0.
   */
  baseTotalMinor: number | null;
  baseTotalDisplay: string | null;
  /**
   * Σ of this line's discount amounts. null when there are none — and also null
   * when any one of them failed to parse, because a partial sum is a confidently
   * wrong number with nothing else in the row to contradict it.
   */
  discountMinor: number | null;
  comment: string | null;
  /** 0-based index in the platform payload. */
  position: number;
  modifiers: OrderItemModifier[];
  discounts: OrderItemDiscount[];
  /**
   * The platform's item object, verbatim. Every field above is a projection of it,
   * and Grab sends ~16 more per line (weight, editedStatus, originalItem, itemTags,
   * outOfStockInstruction…) that nothing reads yet. Kept so answering a new question
   * about old orders is a query, not a re-fetch of history Grab may no longer serve.
   */
  rawJson: unknown;
}

/**
 * The order-level money breakdown, parsed to minor units.
 *
 * null is never 0. It means the platform sent one of its "none" sentinels or the
 * string did not parse — and a 0 there would read as a real, free-of-charge figure.
 * The *Display members carry the original string for the fields where that
 * distinction is not otherwise recoverable; see OrderItemModifier.priceDisplay for
 * the same reasoning one level down.
 */
export interface OrderFare {
  /** What the merchant's own total came to, before the customer-side fees below. */
  totalMinor: number | null;
  subtotalMinor: number | null;
  /** What the CUSTOMER paid. Distinct from UnifiedOrder.netAmountMinor, the merchant's take. */
  passengerTotalMinor: number | null;
  taxMinor: number | null;
  deliveryFeeMinor: number | null;
  /** The platform's cut (Grab: fare.mexCommissionDisplay). */
  commissionMinor: number | null;
  merchantChargeMinor: number | null;
  smallOrderFeeMinor: number | null;
  promotionMinor: number | null;
  totalDiscountMinor: number | null;
  reducedPriceMinor: number | null;
  adjustmentByDriverMinor: number | null;
  merchantChargeDisplay: string | null;
  promotionDisplay: string | null;
  totalDiscountDisplay: string | null;
  adjustmentByDriverDisplay: string | null;
}

export interface UnifiedOrder {
  platform: PlatformName;
  platformOrderId: string;
  accountId: string;
  merchantId: string;
  /** Normalized status */
  status: OrderStatus;
  /** Raw platform status string (e.g. 'ORDER_EXECUTING', 'DELIVERED') for re-evaluation */
  platformStatus: string;
  /** Gross amount in minor units, nullable when platform doesn't provide it */
  grossAmountMinor: number | null;
  /** Net earnings in minor units (always available) */
  netAmountMinor: number;
  currency: string;
  /** ISO 8601 UTC timestamp of when the order was placed */
  orderedAt: string;
  /**
   * The platform's own business day this order was reported under ('YYYY-MM-DD',
   * merchant-local). NOT derivable from orderedAt: Grab buckets by a server-side
   * business day that matches neither createdAt nor updatedAt — an order placed
   * 23:33 and settled 00:00:38 the next day still lands in the earlier day's
   * report. Aggregate on this to reconcile with the platform's own dashboard;
   * aggregate on orderedAt to answer "when did customers actually order".
   */
  reportDate: string;
  /** Original timezone of the merchant (IANA name) */
  platformTimezone: string;
  /** ISO 8601 UTC timestamp when the platform last reported this order */
  updatedAt: string;
  /** Full original platform payload for re-normalization */
  rawJson: unknown;
  /**
   * Line items, when the platform exposes them AND the detail fetch succeeded.
   * `undefined` means "not fetched" and MUST leave stored rows untouched; never
   * `[]`, because an empty payload is a failed fetch, not an empty order.
   */
  items?: OrderItem[];
  /**
   * The platform's whole per-order detail response, verbatim — the document `items`
   * and `fare` were both projected out of. Moves with them: set together, stored
   * together, so the raw can never describe a different fetch than the columns do.
   * `undefined` means "not fetched", exactly as it does for `items`.
   *
   * The undecoded body, deliberately: a parsed object is not the response. Grab's
   * encoder emits '&' as a six-character unicode escape, and its int64 `orderFlags`
   * is 131 away from the nearest double, so re-serializing a parse stores neither
   * the same bytes nor the same number — and this column is the copy of record.
   */
  detailRawJson?: string;
  /** The money breakdown from that same payload. Absent for the same reason. */
  fare?: OrderFare;
  /** Why the per-order detail fetch failed. Order-level data is unaffected. */
  itemsError?: string;
  /**
   * Set when the item payload failed the platform's own completeness checks.
   * The lines are still worth storing when we have none, but they must never
   * overwrite lines we already have: a truncated 200 is indistinguishable from
   * an edited order that genuinely lost a line. Enforced in replaceOrderItems.
   */
  itemsSuspect?: string;
}

export type AuthState = 'valid' | 'expired' | 'needs_human';

export class AuthError extends Error {
  constructor(
    public readonly authState: AuthState,
    message?: string,
  ) {
    super(message ?? `Auth state: ${authState}`);
    this.name = 'AuthError';
  }
}

/**
 * Orders already collected when a fetch aborted, stashed on the error itself.
 *
 * Aborting used to be cheap — a day cost one report call. Fetching per-order
 * detail makes it ~45 sequential calls per day, so a session dying at call #40
 * would otherwise discard 44 orders that were fetched successfully. Carrying
 * them on the error keeps the `throw` contract intact (callers that ignore this
 * behave exactly as before) while letting fetchAndStore persist what it has.
 *
 * A symbol, not a field: pino and JSON.stringify must not dump 44 orders into a
 * log line just because they serialized the error.
 */
const PARTIAL_ORDERS = Symbol('partialOrders');

export function attachPartialOrders<E>(err: E, orders: UnifiedOrder[]): E {
  if (err !== null && typeof err === 'object' && orders.length > 0) {
    (err as Record<symbol, unknown>)[PARTIAL_ORDERS] = orders;
  }
  return err;
}

export function getPartialOrders(err: unknown): UnifiedOrder[] {
  if (err === null || typeof err !== 'object') return [];
  const orders = (err as Record<symbol, unknown>)[PARTIAL_ORDERS];
  return Array.isArray(orders) ? orders as UnifiedOrder[] : [];
}

/** Session store interface — implementations persist to DB or memory */
export interface SessionStore {
  get(accountId: string): Promise<unknown | null>;
  set(accountId: string, session: unknown): Promise<void>;
  remove(accountId: string): Promise<void>;
}

/** Optional per-call knobs. An options bag so later additions need no signature change. */
export interface FetchOrdersOptions {
  logger?: Logger;
  /**
   * What the store already knows about one business day's orders, for deciding which
   * per-order detail calls are worth making — see core/detail-refresh.ts.
   *
   * A callback and not a Map so the connector asks once per day, after the day's
   * report has come back and only when it is actually going to use it. Synchronous
   * because the only implementation is better-sqlite3, which is; making it a promise
   * would buy nothing and put an await in the middle of the detail loop.
   *
   * ABSENT MEANS FETCH EVERYTHING. That is what keeps `--force` honest and what makes
   * this addition invisible to any caller that has not opted in: a connector called
   * without it behaves exactly as it did before incremental fetching existed.
   */
  storedDetail?: (reportDate: string) => Map<string, StoredOrderDetail>;
}

export interface PlatformConnector {
  readonly platform: PlatformName;
  /**
   * Fetch orders in the given date range.
   * Throws AuthError if auth expired or broken (surfaced to the scheduler for alerting).
   * A thrown error may carry the orders fetched before it — see getPartialOrders.
   * Implementations MUST use the injected SessionStore for session caching.
   */
  fetchOrders(
    account: PlatformAccount,
    range: DateRange,
    sessionStore: SessionStore,
    opts?: FetchOrdersOptions,
  ): Promise<UnifiedOrder[]>;
  /**
   * Check current auth state using the cached session (one cheap API call, no full login).
   * Only performs a full re-login as a last resort.
   */
  checkAuth(account: PlatformAccount, sessionStore: SessionStore): Promise<AuthState>;
}

export interface FetchRun {
  id?: number;
  platform: PlatformName;
  accountId: string;
  dateFrom: string; // 'YYYY-MM-DD'
  dateTo: string;   // 'YYYY-MM-DD'
  status: 'success' | 'failure' | 'partial';
  orderCount: number;
  errorMessage?: string;
  startedAt: string; // ISO 8601
  completedAt?: string; // ISO 8601
}
