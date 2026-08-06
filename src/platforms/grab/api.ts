import { GrabSession } from './auth.js';
import { DateRange, AuthError } from '../../core/types.js';

const BASE_URL = 'https://api.grab.com/delvplatformapi/merchant/v1/reports/daily-pagination';
const ORDER_DETAIL_URL = 'https://api.grab.com/food/merchant/v3/orders';

export interface GrabStatement {
  ID: string;
  currency: { code: string; symbol: string; exponent: string; exponentUnit: number };
  orderEarningsInMinorUnit: number;
  deliveryStatus: string;
  createdAt: string;
  bookingCode: string;
  priceDisplay: string;
  updatedAt: string;
  displayID: string;
  cancelRole?: string;
  cancelledAt?: string | null;
  cancelledOriginalPriceDisplay?: string;
  hasPromo?: boolean;
  isTakeawayOrder?: boolean;
  isScheduledOrder?: boolean;
  isLargeOrder?: boolean;
  [key: string]: unknown;
}

/**
 * The daily report carries no line items — only this per-order endpoint does.
 * Declared fields are the ones we read; the payload has ~60 more top-level keys.
 */
export interface GrabOrder {
  orderID: string;
  state?: string;
  isOrderEdited?: boolean;
  itemInfo?: { count?: number; items?: GrabOrderItem[] | null } | null;
  fare?: {
    currencySymbol?: string;
    /** Integer minor units, and Σ items[].fare.priceInMin — the completeness check. */
    originalPriceInMin?: number;
    subTotalDisplay?: string;
    totalDisplay?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GrabOrderItem {
  itemKey?: string;
  itemID?: string;
  name?: string;
  quantity?: number;
  fare?: {
    priceInMin?: number;
    originalItemPriceDisplay?: string;
    priceDisplay?: string;
    [key: string]: unknown;
  };
  modifierGroups?: GrabModifierGroup[] | null;
  discountInfo?: GrabItemDiscount[] | null;
  comment?: string;
  skuID?: string;
  itemCode?: string;
  barcode?: string;
  [key: string]: unknown;
}

export interface GrabModifierGroup {
  modifierGroupID?: string;
  modifierGroupName?: string;
  modifiers?: GrabModifier[] | null;
}

export interface GrabModifier {
  modifierID?: string;
  modifierName?: string;
  /**
   * The PER-UNIT price, and the only modifier price we store.
   *
   * revampedPriceDisplay sits beside it and is NOT a duplicate — it is this price
   * times the PARENT ITEM's quantity ('10.000' vs '20.000' on a qty-2 line; 5 of 35
   * modifiers differ in data/sample-order-details.json, all of them on qty>1 lines).
   * Storing the per-unit figure is what makes schema.ts's self-check hold:
   * base_total_minor + quantity * Σ(modifier price_minor) = line_total_minor.
   */
  priceDisplay?: string;
  quantity?: number;
  [key: string]: unknown;
}

export interface GrabItemDiscount {
  discountName?: string;
  /** An AMOUNT, not the discounted price, despite the name. */
  itemDiscountPriceDisplay?: string;
  discountType?: string;
  discountFunding?: string;
  [key: string]: unknown;
}

function cookieHeader(session: GrabSession): string {
  return Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

export async function fetchDailyReport(
  session: GrabSession,
  range: DateRange,
  timezone: string,
  pageSize = 50,
  timeoutMs = 60_000,
): Promise<GrabStatement[]> {
  const allStatements: GrabStatement[] = [];
  let pageIndex = 0;

  // Range is already 'YYYY-MM-DD' — append timezone offset directly
  const startTime = `${range.from}T00:00:00${formatTzOffset(timezone)}`;
  const endTime = `${range.to}T23:59:59${formatTzOffset(timezone)}`;

  while (true) {
    const params = new URLSearchParams({
      states: '',
      startTime,
      endTime,
      pageIndex: String(pageIndex),
      pageSize: String(pageSize),
    });

    const resp = await fetch(`${BASE_URL}?${params}`, {
      headers: {
        accept: '*/*',
        origin: 'https://merchant.grab.com',
        cookie: cookieHeader(session),
      },
      // undici defaults to a 300s header timeout. Unbounded stalls are how a
      // nightly run wedges forever without ever failing loudly.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      if (resp.status === 401) throw new AuthError('expired', 'Grab session expired');
      throw new Error(`Grab API error: HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const statements: GrabStatement[] = data.statements || [];
    allStatements.push(...statements);
    // Driver-independent stop: a short page is the last page. The captured
    // envelope (data/sample-grab-3.json) has no hasMore field, so only trust
    // hasMore when it's explicitly false — `!undefined` would stop at page 0.
    if (statements.length < pageSize) break;
    if (data.hasMore === false) break;
    pageIndex++;
  }

  return allStatements;
}

/**
 * One order's full detail — line items, modifiers and item-level discounts, none
 * of which the daily report carries. `orderId` is the statement's own ID.
 */
export async function fetchOrderDetail(
  session: GrabSession,
  orderId: string,
  timeoutMs = 30_000,
): Promise<GrabOrder> {
  const resp = await fetch(`${ORDER_DETAIL_URL}/${encodeURIComponent(orderId)}`, {
    headers: {
      accept: '*/*',
      origin: 'https://merchant.grab.com',
      cookie: cookieHeader(session),
    },
    // Tighter than the report's: this runs once per order, so a stall here is
    // multiplied by ~45 a day.
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    if (resp.status === 401) throw new AuthError('expired', 'Grab session expired');
    throw new Error(`Grab API error: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  if (!data?.order) throw new Error('Grab order detail response has no order');
  return data.order as GrabOrder;
}

export function formatTzOffset(timezone: string): string {
  // Support IANA names via a simple lookup for common ones
  const ianaMap: Record<string, string> = {
    'Asia/Ho_Chi_Minh': '+07:00',
    'Asia/Bangkok': '+07:00',
    'Asia/Singapore': '+08:00',
    'Asia/Kuala_Lumpur': '+08:00',
    'Asia/Manila': '+08:00',
    'Asia/Jakarta': '+07:00',
    'UTC': '+00:00',
  };
  if (ianaMap[timezone]) return ianaMap[timezone];
  // Direct offset string like "+07:00"
  const match = timezone.match(/^([+-]\d{2}):?(\d{2})$/);
  if (match) return `${match[1]}:${match[2]}`;
  // Fail hard — no silent fallback
  throw new Error(`Unrecognized timezone: ${timezone}. Must be IANA name (e.g. Asia/Ho_Chi_Minh) or offset (+07:00)`);
}
