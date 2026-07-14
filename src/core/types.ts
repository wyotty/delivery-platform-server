// src/core/types.ts

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
  /** Original timezone of the merchant (IANA name) */
  platformTimezone: string;
  /** ISO 8601 UTC timestamp when the platform last reported this order */
  updatedAt: string;
  /** Full original platform payload for re-normalization */
  rawJson: unknown;
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

/** Session store interface — implementations persist to DB or memory */
export interface SessionStore {
  get(accountId: string): Promise<unknown | null>;
  set(accountId: string, session: unknown): Promise<void>;
  remove(accountId: string): Promise<void>;
}

export interface PlatformConnector {
  readonly platform: PlatformName;
  /**
   * Fetch orders in the given date range.
   * Throws AuthError if auth expired or broken (surfaced to the scheduler for alerting).
   * Implementations MUST use the injected SessionStore for session caching.
   */
  fetchOrders(account: PlatformAccount, range: DateRange, sessionStore: SessionStore): Promise<UnifiedOrder[]>;
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
