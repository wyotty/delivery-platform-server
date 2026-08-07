import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { UnifiedOrder, FetchRun, SessionStore, AuthState, OrderFare, OrderItemDiscount } from '../core/types.js';
import { parseJsonLossless } from '../core/json.js';
import { orderLabel, unstorableReason } from '../core/order-guard.js';

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

export interface ItemWriteFailure { platformOrderId: string; error: string }
/** An order nothing at all could be stored for, and why. Same shape, worse loss. */
export interface OrderWriteFailure { platformOrderId: string; error: string }

export interface UpsertOrdersResult {
  /**
   * Orders that could not be written AT ALL — no row, so they are in no total and no
   * report. Named, with the field that stopped them; see core/order-guard.ts.
   */
  orderFailures: OrderWriteFailure[];
  /** Orders whose line items could not be written. Their order-level row still landed. */
  itemFailures: ItemWriteFailure[];
  /**
   * The orders whose order-level row actually landed. Any tally the caller derives
   * has to come from this and not from what it handed in: a rejected order's figures
   * are precisely the ones that could not be read, so summing them produces a
   * revenue of '0[object Object]' rather than a number.
   */
  stored: UnifiedOrder[];
  itemsWritten: number;
}

export function upsertOrders(orders: UnifiedOrder[]): UpsertOrdersResult {
  // Vetted before the transaction opens, so a malformed order is never a statement
  // the transaction has to survive — and phase 2 never goes looking for a row that
  // was never written.
  const orderFailures: OrderWriteFailure[] = [];
  const storable: UnifiedOrder[] = [];
  for (const o of orders) {
    const reason = unstorableReason(o);
    if (reason) orderFailures.push({ platformOrderId: orderLabel(o), error: reason });
    else storable.push(o);
  }

  // Phase 1 — order-level rows, one transaction, exactly as before. Item payloads
  // are the new and fragile part; one bad line must not roll back the night's 44
  // orders along with it.
  //
  // The per-order catch is a BACKSTOP for what the guard above cannot enumerate: an
  // unserializable rawJson, an account row deleted out from under us. A failed
  // statement rolls back only itself, so this stays one transaction and still commits
  // every order that worked (verified against this schema). It is not a substitute
  // for the guard — the coercions the guard exists for raise nothing to catch, and a
  // bind error names neither the order nor the field.
  const stored: UnifiedOrder[] = [];
  db.transaction(() => {
    for (const o of storable) {
      try {
        upsertOrder(o);
        stored.push(o);
      } catch (err) {
        orderFailures.push({
          platformOrderId: orderLabel(o),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  // Phase 2 — items, a transaction per order, so a failure costs that order's lines
  // and nothing else. Over `stored`, not `orders`: an order with no row would fail
  // here a second time, reported as a missing row rather than as the field that
  // actually stopped it.
  const itemFailures: ItemWriteFailure[] = [];
  let itemsWritten = 0;
  for (const o of stored) {
    if (!o.items) continue; // undefined = not fetched; never "no items"
    try {
      replaceOrderItems(o);
      itemsWritten++;
    } catch (err) {
      itemFailures.push({
        platformOrderId: o.platformOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { orderFailures, itemFailures, stored, itemsWritten };
}

// ===== Order items =====

/** Does this order already have stored lines? Gates the destructive write below. */
function hasOrderItems(orderId: number): boolean {
  return db.select({ id: schema.orderItems.id })
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .limit(1)
    .get() !== undefined;
}

/**
 * Replace an order's stored lines with the ones on the payload.
 *
 * Delete-then-insert rather than upsert-and-sweep: an edited order that lost a line
 * has to converge, and modifiers have no natural key that is provably unique within
 * a line — an upsert on one could silently merge two real rows into one. The cost
 * is a surrogate id nobody references; `(order_id, line_key)` is the identity that
 * survives either way.
 */
export function replaceOrderItems(order: UnifiedOrder): void {
  const items = order.items;
  if (!items || items.length === 0) throw new Error('No items to write');

  const row = db.select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(
      eq(schema.orders.platform, order.platform),
      eq(schema.orders.platformOrderId, order.platformOrderId),
    ))
    .get();
  // Phase 1 committed before this ran, so a missing row can only be a bug.
  if (!row) throw new Error(`Order row missing: ${order.platform}/${order.platformOrderId}`);

  if (order.itemsSuspect && hasOrderItems(row.id)) {
    // The payload failed its own completeness checks, and this write deletes before
    // it inserts. Keeping rows that are possibly stale beats destroying rows that
    // are definitely real; with nothing stored yet, partial data still wins.
    //
    // Refusing the WRITE is not a reason to throw the payload away: it is the only
    // record of what Grab returned, the refusal repeats every night until a human
    // looks, and the endpoint will not serve that night twice. Its own column, so
    // detail_raw_json keeps describing the lines that are actually stored.
    if (order.detailRawJson != null) {
      db.update(schema.orders)
        .set({ rejectedDetailRawJson: order.detailRawJson })
        .where(eq(schema.orders.id, row.id))
        .run();
    }
    throw new Error(`Refusing to overwrite stored items with a suspect payload: ${order.itemsSuspect}`);
  }

  db.transaction(() => {
    // Modifiers first, keyed on order_id: one indexed statement that does not lean
    // on FK cascade being enabled (drizzle-kit's own table rebuilds turn it off).
    db.delete(schema.orderItemModifiers).where(eq(schema.orderItemModifiers.orderId, row.id)).run();
    db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, row.id)).run();

    for (const item of items) {
      const inserted = db.insert(schema.orderItems)
        .values({
          orderId: row.id,
          position: item.position,
          lineKey: item.lineKey,
          platformItemId: item.platformItemId,
          name: item.name,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
          unitPriceMinor: item.unitPriceMinor,
          baseTotalMinor: item.baseTotalMinor,
          baseTotalDisplay: item.baseTotalDisplay,
          discountMinor: item.discountMinor,
          discountsJson: item.discounts.length > 0 ? JSON.stringify(item.discounts) : null,
          comment: item.comment,
          skuId: item.skuId,
          itemCode: item.itemCode,
          barcode: item.barcode,
          currency: order.currency,
          rawJson: JSON.stringify(item.rawJson),
        })
        .returning({ id: schema.orderItems.id })
        .get();

      if (item.modifiers.length > 0) {
        db.insert(schema.orderItemModifiers)
          .values(item.modifiers.map(m => ({
            orderId: row.id,
            orderItemId: inserted.id,
            position: m.position,
            groupId: m.groupId,
            groupName: m.groupName,
            platformModifierId: m.platformModifierId,
            name: m.name,
            quantity: m.quantity,
            priceMinor: m.priceMinor,
            priceDisplay: m.priceDisplay,
          })))
          .run();
      }
    }

    // Stamped only here, never in upsertOrder's conflict set — a night where the
    // detail call failed must not overwrite a real timestamp with null.
    db.update(schema.orders)
      .set({
        itemsFetchedAt: new Date().toISOString(),
        // Describes the lines written immediately above, so it is set and cleared
        // with them: the suspect reason lands with a partial payload, and the next
        // clean payload that replaces those lines clears it back to NULL. Anything
        // less and a row stays flagged after it was fixed, or worse, stays clean
        // after a suspect payload was stored into it.
        itemsSuspect: order.itemsSuspect ?? null,
        // The document the lines above came out of, and the money parsed from it —
        // in this same statement for the same reason as items_suspect. Stored and
        // replaced as one unit, so detail_raw_json always describes the fetch that
        // produced the rows sitting beside it, and no fare figure can outlive the
        // payload it was read from.
        //
        // Written as handed over, NOT re-serialized: it is already the response body
        // (UnifiedOrder.detailRawJson), and a JSON.stringify here is exactly the step
        // that used to round `orderFlags` on its way into the column.
        detailRawJson: order.detailRawJson ?? null,
        // This payload was accepted, so nothing is being refused any more.
        rejectedDetailRawJson: null,
        ...fareColumns(order.fare),
      })
      .where(eq(schema.orders.id, row.id))
      .run();
  });
}

/**
 * Every fare column, always — a partial set would let a figure parsed from an
 * earlier payload survive alongside lines from a later one, which is precisely the
 * raw-vs-parsed disagreement that storing both is meant to make impossible. `??`
 * rather than `||`: a genuine 0 (taxDisplay is '0' on most orders) must stay 0.
 */
function fareColumns(fare: OrderFare | undefined) {
  return {
    fareTotalMinor: fare?.totalMinor ?? null,
    fareSubtotalMinor: fare?.subtotalMinor ?? null,
    farePassengerTotalMinor: fare?.passengerTotalMinor ?? null,
    fareTaxMinor: fare?.taxMinor ?? null,
    fareDeliveryFeeMinor: fare?.deliveryFeeMinor ?? null,
    fareCommissionMinor: fare?.commissionMinor ?? null,
    fareMerchantChargeMinor: fare?.merchantChargeMinor ?? null,
    fareSmallOrderFeeMinor: fare?.smallOrderFeeMinor ?? null,
    farePromotionMinor: fare?.promotionMinor ?? null,
    fareTotalDiscountMinor: fare?.totalDiscountMinor ?? null,
    fareReducedPriceMinor: fare?.reducedPriceMinor ?? null,
    fareAdjustmentByDriverMinor: fare?.adjustmentByDriverMinor ?? null,
    fareMerchantChargeDisplay: fare?.merchantChargeDisplay ?? null,
    farePromotionDisplay: fare?.promotionDisplay ?? null,
    fareTotalDiscountDisplay: fare?.totalDiscountDisplay ?? null,
    fareAdjustmentByDriverDisplay: fare?.adjustmentByDriverDisplay ?? null,
  };
}

export type OrderItemModifierRow = typeof schema.orderItemModifiers.$inferSelect;
export type OrderItemRow = Omit<typeof schema.orderItems.$inferSelect, 'discountsJson' | 'rawJson'> & {
  discounts: OrderItemDiscount[];
  modifiers: OrderItemModifierRow[];
  /** Decoded, never the stored string. null only for lines written before raw capture. */
  rawJson: unknown;
};

/** An order's lines with their modifiers nested. Two queries, never 1 + N. */
export function getOrderItems(orderId: number): OrderItemRow[] {
  const items = db.select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, orderId))
    .orderBy(schema.orderItems.position)
    .all();
  if (items.length === 0) return [];

  // The denormalized order_id is what makes this one indexed query instead of one per line.
  const modifiers = db.select()
    .from(schema.orderItemModifiers)
    .where(eq(schema.orderItemModifiers.orderId, orderId))
    .orderBy(schema.orderItemModifiers.orderItemId, schema.orderItemModifiers.position)
    .all();

  const byItem = new Map<number, OrderItemModifierRow[]>();
  for (const m of modifiers) {
    const list = byItem.get(m.orderItemId);
    if (list) list.push(m);
    else byItem.set(m.orderItemId, [m]);
  }

  // Decoded here, so the API hands back structured data and never a JSON string.
  // The raw goes through parseJsonLossless: a plain JSON.parse would re-introduce
  // on the read path exactly the rounding the write path was fixed to avoid, and
  // the API serializes whatever this returns straight back out.
  return items.map(({ discountsJson, rawJson, ...item }) => ({
    ...item,
    discounts: discountsJson ? JSON.parse(discountsJson) as OrderItemDiscount[] : [],
    rawJson: rawJson ? parseJsonLossless(rawJson) : null,
    modifiers: byItem.get(item.id) ?? [],
  }));
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

/**
 * List orders newest-first. rawJson excluded — it's a blob, fetch it via getOrder.
 *
 * Carries items_fetched_at but deliberately NOT an item count. The count would cost
 * a correlated subquery on every one of up to 5000 rows, and it answers nothing this
 * column doesn't: replaceOrderItems refuses an empty payload, so a fetched order
 * always has at least one line. NULL here is the only signal that matters in a list
 * ("which orders in this range never got their detail call?"); how many lines and
 * what they are is a per-order question, and /orders/:id already answers it.
 */
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
    itemsFetchedAt: schema.orders.itemsFetchedAt,
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
