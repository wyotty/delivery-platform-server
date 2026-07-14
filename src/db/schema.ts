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
  platformTimezone: text('platform_timezone').notNull(),
  updatedAt: text('updated_at').notNull(),
  rawJson: text('raw_json').notNull(), // JSON string
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
}, (table) => ({
  // Unique constraint for upsert — CRITICAL: required by onConflictDoUpdate
  platformOrderIdx: uniqueIndex('idx_orders_platform_order').on(table.platform, table.platformOrderId),
  // Index for the primary query shape: merchant_id + ordered_at range scans
  merchantDateIdx: index('idx_orders_merchant_date').on(table.merchantId, table.orderedAt),
  // Index for account-level queries
  accountIdx: index('idx_orders_account').on(table.accountId, table.orderedAt),
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
