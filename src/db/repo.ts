import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { UnifiedOrder, FetchRun, SessionStore, AuthState } from '../core/types.js';

// `||` not `??` — .env.example ships an empty `DB_PATH=`, and dotenv turns that
// into '' which `??` would happily pass through to an anonymous temp database
const dbPath = process.env.DB_PATH || 'data/delivery.db';
mkdirSync(dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
export const db = drizzle(sqlite, { schema });

// ===== Orders =====

export function upsertOrder(order: UnifiedOrder) {
  db.insert(schema.orders)
    .values({
      platform: order.platform,
      platformOrderId: order.platformOrderId,
      accountId: order.accountId,
      merchantId: order.merchantId,
      status: order.status,
      platformStatus: order.platformStatus,
      grossAmountMinor: order.grossAmountMinor,
      netAmountMinor: order.netAmountMinor,
      currency: order.currency,
      orderedAt: order.orderedAt,
      reportDate: order.reportDate,
      platformTimezone: order.platformTimezone,
      updatedAt: order.updatedAt,
      rawJson: JSON.stringify(order.rawJson),
    })
    .onConflictDoUpdate({
      target: [schema.orders.platform, schema.orders.platformOrderId],
      set: {
        status: order.status,
        platformStatus: order.platformStatus,
        netAmountMinor: order.netAmountMinor,
        grossAmountMinor: order.grossAmountMinor,
        // Re-fetching a day can only ever reconfirm that day: a given order is
        // returned under exactly one business day, so this is not a moving target.
        reportDate: order.reportDate,
        updatedAt: order.updatedAt,
        rawJson: JSON.stringify(order.rawJson),
      },
    })
    .run();
}

// Single transaction for bulk upserts
export function upsertOrders(orders: UnifiedOrder[]) {
  db.transaction(() => {
    for (const o of orders) upsertOrder(o);
  });
}

// ===== Fetch runs =====

export function logFetchRun(run: FetchRun) {
  db.insert(schema.fetchRuns)
    .values({
      platform: run.platform,
      accountId: run.accountId,
      dateFrom: run.dateFrom,
      dateTo: run.dateTo,
      status: run.status,
      orderCount: run.orderCount,
      errorMessage: run.errorMessage ?? null,
      startedAt: run.startedAt,
      completedAt: run.completedAt ?? null,
    })
    .run();
}

// ===== Session store (DB-backed) =====

export class DbSessionStore implements SessionStore {
  async get(accountId: string): Promise<unknown | null> {
    const row = db.select()
      .from(schema.platformSessions)
      .where(eq(schema.platformSessions.accountId, accountId))
      .get();
    if (!row) return null;
    return JSON.parse(row.sessionJson);
  }

  async set(accountId: string, session: unknown): Promise<void> {
    db.insert(schema.platformSessions)
      .values({
        accountId,
        sessionJson: JSON.stringify(session),
        state: 'valid',
        fetchedAt: Math.floor(Date.now() / 1000),
      })
      .onConflictDoUpdate({
        target: schema.platformSessions.accountId,
        set: {
          sessionJson: JSON.stringify(session),
          state: 'valid',
          fetchedAt: Math.floor(Date.now() / 1000),
        },
      })
      .run();
  }

  async remove(accountId: string): Promise<void> {
    db.delete(schema.platformSessions)
      .where(eq(schema.platformSessions.accountId, accountId))
      .run();
  }
}

// ===== Session state (needs_human gating + alerting) =====

/**
 * Upsert, not update: auth can break before any session was ever stored (first
 * login fails), and an UPDATE against the missing row would silently record
 * nothing — leaving the scheduler to retry a broken login every night forever.
 */
export function setSessionState(accountId: string, state: AuthState) {
  db.insert(schema.platformSessions)
    .values({
      accountId,
      sessionJson: '{}', // no valid session exists; fetchedAt 0 = treated as expired everywhere
      state,
      fetchedAt: 0,
    })
    .onConflictDoUpdate({
      target: schema.platformSessions.accountId,
      set: { state, updatedAt: new Date().toISOString() },
    })
    .run();
}

/** Auth is broken beyond auto-recovery — scheduler skips this account until a human re-auths (CLI import-session). */
export function markSessionNeedsHuman(accountId: string) {
  setSessionState(accountId, 'needs_human');
}

export function getSessionState(accountId: string): AuthState | null {
  const row = db.select({ state: schema.platformSessions.state })
    .from(schema.platformSessions)
    .where(eq(schema.platformSessions.accountId, accountId))
    .get();
  return row?.state ?? null;
}

// ===== Platform accounts =====

export type PlatformAccountRow = typeof schema.platformAccounts.$inferSelect;

export function getAccount(accountId: string) {
  return db.select()
    .from(schema.platformAccounts)
    .where(eq(schema.platformAccounts.id, accountId))
    .get();
}

export function listAccounts(): PlatformAccountRow[] {
  return db.select().from(schema.platformAccounts).all();
}

// ===== Reporting queries =====

export interface SummaryRow {
  platform: string;
  reportDate: string;
  currency: string;
  orderCount: number;
  completedCount: number;
  cancelledCount: number;
  revenueMinor: number;
}

/**
 * Per-platform, per-day totals over the platform's own business day.
 * Revenue counts completed orders only — cancelled Grab statements can still
 * carry a non-zero earnings figure, and including them overstates takings.
 */
export function getSummary(range: { from: string; to: string; merchantId?: string }): SummaryRow[] {
  const conditions = [
    gte(schema.orders.reportDate, range.from),
    lte(schema.orders.reportDate, range.to),
  ];
  if (range.merchantId) conditions.push(eq(schema.orders.merchantId, range.merchantId));

  return db.select({
    platform: schema.orders.platform,
    reportDate: schema.orders.reportDate,
    currency: schema.orders.currency,
    orderCount: sql<number>`count(*)`,
    completedCount: sql<number>`sum(case when ${schema.orders.status} = 'completed' then 1 else 0 end)`,
    cancelledCount: sql<number>`sum(case when ${schema.orders.status} = 'cancelled' then 1 else 0 end)`,
    revenueMinor: sql<number>`coalesce(sum(case when ${schema.orders.status} = 'completed' then ${schema.orders.netAmountMinor} else 0 end), 0)`,
  })
    .from(schema.orders)
    .where(and(...conditions))
    .groupBy(schema.orders.platform, schema.orders.reportDate, schema.orders.currency)
    .orderBy(schema.orders.reportDate, schema.orders.platform)
    .all();
}

/** List orders newest-first. rawJson excluded — it's a blob, fetch it via getOrder. */
export function listOrders(range: { from: string; to: string; merchantId?: string; platform?: string; limit?: number }) {
  const conditions = [
    gte(schema.orders.reportDate, range.from),
    lte(schema.orders.reportDate, range.to),
  ];
  if (range.merchantId) conditions.push(eq(schema.orders.merchantId, range.merchantId));
  if (range.platform) conditions.push(eq(schema.orders.platform, range.platform));

  return db.select({
    id: schema.orders.id,
    platform: schema.orders.platform,
    platformOrderId: schema.orders.platformOrderId,
    merchantId: schema.orders.merchantId,
    status: schema.orders.status,
    platformStatus: schema.orders.platformStatus,
    netAmountMinor: schema.orders.netAmountMinor,
    grossAmountMinor: schema.orders.grossAmountMinor,
    currency: schema.orders.currency,
    orderedAt: schema.orders.orderedAt,
    reportDate: schema.orders.reportDate,
  })
    .from(schema.orders)
    .where(and(...conditions))
    .orderBy(desc(schema.orders.orderedAt))
    .limit(range.limit ?? 500)
    .all();
}

export function getOrder(id: number) {
  return db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
}

export function listFetchRuns(limit = 50) {
  return db.select()
    .from(schema.fetchRuns)
    .orderBy(desc(schema.fetchRuns.id))
    .limit(limit)
    .all();
}
