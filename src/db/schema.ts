import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

export const merchants = sqliteTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
});

export const platformAccounts = sqliteTable('platform_accounts', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  platform: text('platform').notNull(),
  label: text('label').notNull(),
  // Credentials reference (not stored raw) — actual credentials in .env, this is a lookup key
  credentialKey: text('credential_key').notNull(),
  config: text('config').notNull().$default(() => '{}'), // JSON
  timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'), // IANA name (lives on account, not merchant)
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
});

export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  platformOrderId: text('platform_order_id').notNull(),
  accountId: text('account_id').notNull().references(() => platformAccounts.id),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  status: text('status').notNull().$type<'completed' | 'cancelled' | 'refunded' | 'in_progress' | 'other'>(),
  platformStatus: text('platform_status').notNull(),
  grossAmountMinor: integer('gross_amount_minor'), // nullable — platform may not provide
  netAmountMinor: integer('net_amount_minor').notNull(),
  currency: text('currency').notNull(),
  orderedAt: text('ordered_at').notNull(),
  // The platform's own business day ('YYYY-MM-DD'). Reconciles with the platform
  // dashboard; ordered_at does not — see UnifiedOrder.reportDate.
  reportDate: text('report_date').notNull(),
  platformTimezone: text('platform_timezone').notNull(),
  updatedAt: text('updated_at').notNull(),
  rawJson: text('raw_json').notNull(), // JSON string
  // When line items were last written for this order. NULL = never fetched, or the
  // last detail call failed — which is a different answer from "this order has no
  // items", and both the dashboard and the backfill need to tell them apart.
  itemsFetchedAt: text('items_fetched_at'),
  // Why the payload that produced the STORED lines failed the platform's own
  // completeness checks (UnifiedOrder.itemsSuspect); NULL when it passed. Written in
  // the same statement as items_fetched_at, so it always describes the rows that are
  // actually there, and a later clean payload clears it.
  //
  // Without it these rows are indistinguishable from verified ones forever: a
  // truncated 200 landing on an order with no prior lines IS stored (partial data
  // beats none), and the refusal gate in replaceOrderItems only fires on the NEXT
  // write — by which time nothing records that the stored lines were ever doubted.
  // `WHERE items_suspect IS NOT NULL` is the only way to find them after the fact.
  itemsSuspect: text('items_suspect'),
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
}, (table) => ({
  // Unique constraint for upsert — CRITICAL: required by onConflictDoUpdate
  platformOrderIdx: uniqueIndex('idx_orders_platform_order').on(table.platform, table.platformOrderId),
  // Index for the primary query shape: merchant_id + report_date range scans
  merchantDateIdx: index('idx_orders_merchant_report_date').on(table.merchantId, table.reportDate),
  // Index for account-level queries
  accountIdx: index('idx_orders_account').on(table.accountId, table.reportDate),
}));

/**
 * One row per order line as the platform reported it. Rewritten wholesale on every
 * re-fetch of the parent order (see replaceOrderItems): a projection of the
 * platform's latest payload, never an accumulator — that is what makes an edited
 * order which lost a line converge instead of keeping a ghost row forever.
 */
export const orderItems = sqliteTable('order_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  // 0-based index in the platform payload. Preserves display order, which is the
  // only ordering the platform gives us.
  position: integer('position').notNull(),
  // Stable per-line key. Grab: itemKey = '<itemID>-<per-line uuid>', hand-verified
  // identical across two separate fetches of the same order. Synthesized as
  // `${platformItemId}#${position}` when the platform omits it, so the unique
  // index below can never be quietly disabled by SQLite's "NULLs are distinct".
  lineKey: text('line_key').notNull(),
  // The platform's catalog id (Grab: itemID). NOT the merchant's SKU — GrabFood
  // merchants have no UI to set one at all (see sku_id).
  platformItemId: text('platform_item_id'),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull(),
  // What the whole line came to: quantity * unit_price_minor, modifiers included,
  // discounts not yet applied. THE column to sum — Σ over an order's lines equals
  // the platform's own order total exactly.
  lineTotalMinor: integer('line_total_minor').notNull(),
  // ONE unit, including that unit's modifiers. Grab's fare.priceInMin verbatim.
  // It is PER-UNIT, not per-line: a qty-2 line reports 69000 on a 138000 line
  // (verified against 7 real quantity>1 lines). Summing this column instead of
  // line_total_minor undercounts every multi-quantity line.
  unitPriceMinor: integer('unit_price_minor').notNull(),
  // The line's base before modifiers (Grab: fare.originalItemPriceDisplay), already
  // scaled by quantity unlike unit_price_minor. Nullable because it is parsed from
  // a display string: NULL means "did not parse", never 0. base_total_display keeps
  // the original, so a parser fix is a SQL job rather than 16k re-fetches.
  //   Self-check, valid at any quantity and over all history:
  //   base_total_minor + quantity * Σ(modifier price_minor) = line_total_minor
  baseTotalMinor: integer('base_total_minor'),
  baseTotalDisplay: text('base_total_display'),
  // Σ of the line's discount amounts; NULL when there are none or when any one of
  // them failed to parse. line_total_minor is pre-discount, so this column is the
  // only record of the discount and an understated value has no cross-check.
  discountMinor: integer('discount_minor'),
  // The normalized OrderItemDiscount[] (parsed amounts + the raw strings), not
  // Grab's shape: leaving an unparsed VND display string in here is how the
  // 1000x separator bug gets reintroduced by the next consumer.
  discountsJson: text('discounts_json'),
  comment: text('comment'), // customer note on the line — free text, may contain PII
  // Merchant-supplied identifiers. Empty on 100% of GrabFood rows; they only ever
  // populate for GrabMart. Stored because they are real fields, but NOTHING may
  // depend on them being non-empty.
  skuId: text('sku_id'),
  itemCode: text('item_code'),
  barcode: text('barcode'),
  // Denormalized from orders.currency so an amount is never read without its unit.
  // Written in the same transaction from the same source; cannot drift.
  currency: text('currency').notNull(),
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
}, (table) => ({
  // The idempotency contract, and a tripwire: if the platform ever stops making
  // its line key unique per line, this fails loudly for that one order instead of
  // silently collapsing two real lines into one.
  orderLineIdx: uniqueIndex('idx_order_items_order_line').on(table.orderId, table.lineKey),
  // The read path: every line of an order, in payload order.
  orderPositionIdx: index('idx_order_items_order_position').on(table.orderId, table.position),
  // "how many of item X did we sell" — the whole point of collecting this.
  platformItemIdx: index('idx_order_items_platform_item').on(table.platformItemId),
}));

/**
 * One row per modifier chosen on a line, flattened — the group is two columns and
 * not a table, because a group carries nothing beyond its id and name and nothing
 * ever queries groups independently.
 */
export const orderItemModifiers = sqliteTable('order_item_modifiers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Denormalized parent order id. Earns its place twice: it makes "delete every
  // modifier of this order" one indexed statement that does not depend on FK
  // cascade being on, and it makes "all modifiers of an order" a single query.
  orderId: integer('order_id').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  orderItemId: integer('order_item_id').notNull().references(() => orderItems.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(), // 0-based across the line's flattened modifier list
  groupId: text('group_id'),     // Grab: modifierGroupID
  groupName: text('group_name'), // Grab: modifierGroupName
  // Grab: modifierID. Grab has no sku/code/barcode on modifiers anywhere in its
  // model, so this is the only stable identifier a modifier has.
  platformModifierId: text('platform_modifier_id'),
  name: text('name').notNull(),
  quantity: integer('quantity').notNull(),
  // Parsed from price_display, the only price the detail endpoint gives for a
  // modifier. NULL means "did not parse", never 0 — inventing a 0 here is
  // indistinguishable from a genuinely free option.
  priceMinor: integer('price_minor'),
  priceDisplay: text('price_display').notNull(), // raw string, always kept
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
}, (table) => ({
  itemPositionIdx: index('idx_order_item_modifiers_item').on(table.orderItemId, table.position),
  orderIdx: index('idx_order_item_modifiers_order').on(table.orderId),
}));

export const platformSessions = sqliteTable('platform_sessions', {
  accountId: text('account_id').primaryKey().references(() => platformAccounts.id),
  sessionJson: text('session_json').notNull(), // JSON — encrypted at rest in production
  state: text('state').notNull().$type<'valid' | 'expired' | 'needs_human'>().default('valid'),
  fetchedAt: integer('fetched_at').notNull(), // unix seconds
  updatedAt: text('updated_at').notNull().$default(() => new Date().toISOString()),
});

export const fetchRuns = sqliteTable('fetch_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  accountId: text('account_id').notNull().references(() => platformAccounts.id),
  dateFrom: text('date_from').notNull(),
  dateTo: text('date_to').notNull(),
  status: text('status').notNull().$type<'success' | 'failure' | 'partial'>(),
  orderCount: integer('order_count').notNull().default(0),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => ({
  // Index for "did last night's fetch work?" queries
  fetchRunIdx: index('idx_fetch_runs_account_date').on(table.accountId, table.startedAt),
}));
