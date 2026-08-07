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
  // The platform's own report entry for this order — for Grab, ONE element of the
  // daily report's {"statements":[…]}, which is why this one is a re-serialization
  // and detail_raw_json below is a verbatim body: there is no single response here
  // to keep. The element still carries an int64 `orderFlags`, so api.ts parses the
  // report with parseJsonLossless; a plain resp.json() rounded the literal
  // (…077387780 → …077388000) before this column ever saw it. See core/json.ts.
  rawJson: text('raw_json').notNull(),
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
  // The per-order detail RESPONSE BODY, byte for byte — everything the columns
  // below and the order_items rows were parsed out of, plus the ~40 top-level keys
  // nobody reads yet (times, state, paymentMethod, orderChangeLog, incidents, eater,
  // driver, voucherInfo…). The whole `{"order":{…}}` envelope, not the inner object,
  // so a sibling key Grab adds beside `order` is kept too.
  //
  // The body and not a re-serialization of a parse of it, because those are not the
  // same document: Grab's encoder emits '&' as a six-character unicode escape, and
  // `orderFlags` is an int64 bitfield 131 away from the nearest double —
  // parse-then-stringify silently rewrites both, and the flags in the low bits are
  // gone for good. See core/json.ts.
  //
  // Written in the SAME statement as items_fetched_at, so from migration 0004
  // onwards the two always describe the same fetch. They DO disagree on every row
  // written before it: SQLite can only add this column NULL to an already-populated
  // table, so an order fetched under 0003 keeps a real items_fetched_at with NULL
  // here until a backfill re-fetches it — reproduced on a copy of a pre-0004
  // database, where all 18 orders that had lines came out that way (and all 33 of
  // their order_items.raw_json with them, see that column's note).
  //   WHERE items_fetched_at IS NOT NULL AND detail_raw_json IS NULL   -- awaiting backfill
  // Read NULL as "no payload captured", never as "no detail fetch ever happened".
  //
  // Storage, measured over 104 live orders (2026-08-01..05, VND) rather than
  // extrapolated from one: this column averages 8,044 bytes (6,185 min, 13,100 max)
  // and that order's order_items.raw_json rows add 2,819 more. The figure that
  // actually matters is the file's, not the strings' — VACUUMing the same database
  // with and without both columns differs by 12,091 bytes an order, ~110 MB (105 MiB)
  // a year at 25 orders/day. That is the cheap side of the trade: a question we did
  // not anticipate becomes a query instead of a re-fetch of history the platform will
  // not serve twice.
  detailRawJson: text('detail_raw_json'),
  // The body of a fetch whose line-item write was REFUSED — a suspect payload that
  // replaceOrderItems would not let overwrite rows we already have.
  //
  // It cannot go in detail_raw_json without breaking what that column promises (it
  // describes the lines sitting beside it), and it cannot be dropped either: the
  // refusal repeats every night until a human looks, so this is the only surviving
  // evidence of what Grab actually returned, and the endpoint will not serve that
  // night again. Rewritten on each refusal, so it is always the most recent one;
  // cleared the moment a payload is accepted, so it is never stale.
  //   WHERE rejected_detail_raw_json IS NOT NULL   -- orders whose lines are frozen
  rejectedDetailRawJson: text('rejected_detail_raw_json'),
  // Grab's own money breakdown, promoted to columns so the ledger is answerable in
  // SQL without json_extract over the blob above.
  //
  // All nullable, all parsed through parseGrabAmount: the platform reports these as
  // locale-formatted display strings where '.' is a THOUSANDS separator, so a NULL
  // means "sentinel or unparseable" and NEVER 0 — a 0 is a real amount and would be
  // indistinguishable from a fee that was genuinely not charged.
  //
  // net_amount_minor above is what the MERCHANT earns. fare_passenger_total_minor
  // is what the CUSTOMER paid. Neither derives from the other; both are needed.
  fareTotalMinor: integer('fare_total_minor'),
  fareSubtotalMinor: integer('fare_subtotal_minor'),
  farePassengerTotalMinor: integer('fare_passenger_total_minor'),
  fareTaxMinor: integer('fare_tax_minor'),
  fareDeliveryFeeMinor: integer('fare_delivery_fee_minor'),
  fareCommissionMinor: integer('fare_commission_minor'),
  fareMerchantChargeMinor: integer('fare_merchant_charge_minor'),
  fareSmallOrderFeeMinor: integer('fare_small_order_fee_minor'),
  farePromotionMinor: integer('fare_promotion_minor'),
  fareTotalDiscountMinor: integer('fare_total_discount_minor'),
  fareReducedPriceMinor: integer('fare_reduced_price_minor'),
  fareAdjustmentByDriverMinor: integer('fare_adjustment_by_driver_minor'),
  // Kept only beside the four figures Grab reports with a '' or '-' "none"
  // sentinel: there, NULL alone cannot be told apart from a parse that broke.
  //   WHERE fare_promotion_minor IS NULL AND fare_promotion_display NOT IN ('', '-')
  // The other eight carry a plain numeric on all 104 live orders captured
  // (2026-08-01..05); the four above are where every '' and '-' turned up. Their
  // tripwire runs against the stored payload instead of a column of their own —
  // coalesce because a RENAMED key json_extracts to NULL and `NULL NOT IN (…)` is
  // NULL, which would match nothing and read as "all clear":
  //   WHERE fare_total_minor IS NULL AND detail_raw_json IS NOT NULL
  //     AND coalesce(json_extract(detail_raw_json, '$.order.fare.totalDisplay'), '(absent)')
  //         NOT IN ('', '-')
  // and normalizeOrderFare reports every refusal as it happens — a string it will not
  // parse, a value that is not a string, a field that is simply gone — so a format
  // change is audible the night it lands (the connector logs it) rather than only
  // findable afterwards by someone who already suspects it.
  fareMerchantChargeDisplay: text('fare_merchant_charge_display'),
  farePromotionDisplay: text('fare_promotion_display'),
  fareTotalDiscountDisplay: text('fare_total_discount_display'),
  fareAdjustmentByDriverDisplay: text('fare_adjustment_by_driver_display'),
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
  // The platform's item object, verbatim. Deliberately duplicates bytes already in
  // orders.detail_raw_json: it turns "what did this line actually say" into a query
  // on this table instead of a walk into the order blob, and it is where the ~16
  // per-line fields nothing reads yet (weight, editedStatus, originalItem,
  // originalFare, itemTags, outOfStockInstruction…) survive.
  //
  // Nullable ONLY for the rows that predate this column — SQLite cannot add a NOT
  // NULL column to a populated table, and the alternative (defaulting to '{}') would
  // forge a payload that reads as real. NULL here means "written before the raw was
  // captured"; re-fetching the order clears it, because replaceOrderItems rewrites
  // an order's lines wholesale. Every line written from now on has one.
  rawJson: text('raw_json'),
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
  // Parsed from price_display, the only price the detail endpoint gives for a
  // modifier. NULL means "did not parse", never 0 — inventing a 0 here is
  // indistinguishable from a genuinely free option.
  priceMinor: integer('price_minor'),
  // The raw string, always kept — but NULL when Grab sent something that was not a
  // string at all. '' is Grab's own "printed nothing" sentinel, so reusing it for a
  // malformed value would hide a format change inside the one value the documented
  // tripwire query excludes. NULL is never legitimate here, which makes
  // `WHERE price_display IS NULL` the query that finds it; order_items.raw_json
  // still holds whatever actually arrived.
  priceDisplay: text('price_display'),
  // 1 when Grab omits it (its implicit default). NULL only when it sent a value that
  // is not a usable count — see price_display above for why that is not defaulted.
  quantity: integer('quantity'),
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
