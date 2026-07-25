import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { UnifiedOrder, FetchRun, SessionStore } from '../core/types.js';

const dbPath = process.env.DB_PATH ?? 'data/delivery.db';
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

// ===== Session state (needs_human gating for the scheduler) =====

export function getSessionState(accountId: string): 'valid' | 'expired' | 'needs_human' | null {
  const row = db.select({ state: schema.platformSessions.state })
    .from(schema.platformSessions)
    .where(eq(schema.platformSessions.accountId, accountId))
    .get();
  return row?.state ?? null;
}

/** Auth is broken beyond auto-recovery — scheduler skips this account until a human re-auths (CLI import-session). */
export function markSessionNeedsHuman(accountId: string) {
  db.insert(schema.platformSessions)
    .values({
      accountId,
      sessionJson: '{}', // no valid session exists; fetchedAt 0 = treated as expired everywhere
      state: 'needs_human',
      fetchedAt: 0,
    })
    .onConflictDoUpdate({
      target: schema.platformSessions.accountId,
      set: { state: 'needs_human' },
    })
    .run();
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
