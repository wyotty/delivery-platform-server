import { GrabSession } from './auth.js';
import { DateRange, AuthError } from '../../core/types.js';

const BASE_URL = 'https://api.grab.com/delvplatformapi/merchant/v1/reports/daily-pagination';

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

export async function fetchDailyReport(
  session: GrabSession,
  range: DateRange,
  timezone: string,
  pageSize = 50,
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
        cookie: Object.entries(session.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      },
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
