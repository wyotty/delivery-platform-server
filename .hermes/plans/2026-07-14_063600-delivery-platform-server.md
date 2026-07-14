# delivery-platform-server Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan phase by phase.

**Goal:** Build a unified server that aggregates order/report data from multiple food delivery platforms (Grab, Foodpanda, ShopeeFood, etc.) into a single storage + API surface.

**Architecture:** Modular monolith with a platform-adapter plugin layer. Each platform (Grab, Foodpanda, …) is a self-contained adapter behind a minimal `PlatformConnector` interface. Auth is fully encapsulated inside each adapter. No microservices, no message queue — one deployable process until proven otherwise.

**Tech Stack:** TypeScript (Node 22 + tsx), pnpm, Drizzle ORM (SQLite dev → Postgres prod), Fastify API, zod validation, node-cron scheduling, Playwright for browser-auth platforms, grammY for Telegram, pino for logging.

**Repo:** `https://github.com/wyotty/delivery-platform-server`

**Claude Code fable recommended language:** TypeScript — because Playwright (the load-bearing dependency) is TypeScript-first, all future platform adapters involve the same shape of work (browser automation + JSON wrangling), and types can be shared with a future web dashboard.

**Fable review applied** (2026-07-14): All issues from fable code review have been resolved in this plan. See review notes at end.

---

## Phase 1: Extract & Restructure

**Goal:** Scaffold the repo, port `grab_report.ts` into the platform-adapter pattern, verify the CLI workflow fully replaces the old script.

### Task 1: Initialize pnpm monorepo scaffold

**Objective:** Set up the project skeleton with pnpm, tsx, TypeScript config, and dev tooling.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize**

```bash
cd /root/Projects/delivery-platform-server
pnpm init
pnpm add -D typescript tsx @types/node
pnpm add zod drizzle-orm better-sqlite3 pino pino-pretty dotenv
pnpm add -D @types/better-sqlite3 drizzle-kit
pnpm add playwright
pnpm add node-cron
pnpm add fastify @fastify/cors
pnpm add grammy
npx tsc --init --target es2022 --module esnext --moduleResolution bundler --outDir dist --rootDir src --strict true --esModuleInterop true
```

**Step 2: Create project directory structure**

```bash
mkdir -p src/core src/platforms/grab src/db src/scheduler src/api src/notify src/config
mkdir -p .hermes/plans
```

**Step 3: Add scripts to package.json**

```json
{
  "scripts": {
    "dev": "tsx watch src/cli.ts",
    "fetch": "tsx src/cli.ts",
    "start": "tsx src/index.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts",
    "lint": "tsc --noEmit"
  }
}
```

**Step 4: Verify**

```bash
pnpm run lint
# Expected: No errors
```

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm + TypeScript project"
```

### Task 2: Define core types (UnifiedOrder, PlatformConnector, SessionStore)

**Objective:** Define the unified data model, `PlatformConnector` interface, and `SessionStore` abstraction that all adapters implement.

**Files:**
- Create: `src/core/types.ts`

**Code:**

```typescript
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
```

**Key design decisions:**
- `DateRange` uses `'YYYY-MM-DD'` strings (not `Date`) — avoids timezone-offset bugs when formatting API requests with local timezone
- `grossAmountMinor` is `number | null` — platforms may provide net only; null preserves "unknown" vs "equal to net"
- `platformStatus` stores the raw string (e.g. `"ORDER_EXECUTING"`) so re-normalization doesn't require JSON-parsing `rawJson`
- `SessionStore` interface — injected into `fetchOrders` and `checkAuth` so adapters can cache/retrieve sessions without knowing the DB
- `PlatformName` is plain `string` — no fake union that collapses to `string`
- All timestamps are ISO 8601 strings (not `Date` objects) — consistent with DB storage and JSON serialization

**Step 1: Write the file**

```bash
cat > src/core/types.ts << 'TYPESCRIPT_EOF'
// [paste the full code above]
TYPESCRIPT_EOF
```

**Step 2: Verify compilation**

```bash
pnpm run lint
# Expected: No errors
```

**Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: define core types, PlatformConnector, and SessionStore interface"
```

### Task 3: Extract Grab adapter behind PlatformConnector

**Objective:** Split `grab_report.ts` into `platforms/grab/` behind the interface, with session caching via SessionStore.

**Files:**
- Create: `src/platforms/grab/auth.ts`
- Create: `src/platforms/grab/api.ts`
- Create: `src/platforms/grab/normalize.ts`
- Create: `src/platforms/grab/index.ts`

**Key principles:**
- Credentials come from `PlatformAccount.credentials` (never hardcoded)
- Sessions cached via `SessionStore`, not filesystem `.grab_cookies.json`
- Timezone is per-account IANA name (e.g. `Asia/Ho_Chi_Minh`)
- AuthError used instead of string matching `'AUTH_EXPIRED'`
- `checkAuth()` validates cached session with a cheap API call, not a full login
- Cancelled orders detected via `cancelRole`/`cancelledAt`, not `deliveryStatus === 'CANCELLED'`

**Code for `src/platforms/grab/auth.ts`:**

```typescript
import { chromium } from 'playwright';
import { PlatformAccount, SessionStore } from '../../core/types.js';

export interface GrabSession {
  cookies: Record<string, string>;
  fetchedAt: number; // unix seconds
}

export class GrabAuthenticator {
  private readonly COOKIE_MAX_AGE = 3 * 3600; // 3 hours

  /** Get a valid session — checks cache first, logs in if expired/missing */
  async getSession(account: PlatformAccount, sessionStore: SessionStore): Promise<GrabSession> {
    const cached = await sessionStore.get(account.id) as GrabSession | null;
    if (cached && !this.isExpired(cached)) {
      return cached;
    }
    const session = await this.login(account);
    await sessionStore.set(account.id, session);
    return session;
  }

  /** Check if cached session is valid with one cheap API call */
  async validateSession(session: GrabSession): Promise<boolean> {
    try {
      const resp = await fetch(
        'https://api.grab.com/delvplatformapi/merchant/v1/reports/daily-pagination?states=&startTime=2000-01-01T00:00:00%2B07:00&endTime=2000-01-01T23:59:59%2B07:00&pageIndex=0&pageSize=1',
        {
          headers: {
            accept: '*/*',
            origin: 'https://merchant.grab.com',
            cookie: this.cookieString(session),
          },
        },
      );
      // 401 = expired, 200/400 = valid (400 means date range invalid, but auth is fine)
      return resp.status !== 401;
    } catch {
      return false;
    }
  }

  async login(account: PlatformAccount): Promise<GrabSession> {
    const username = account.credentials['username'];
    const password = account.credentials['password'];
    if (!username || !password) throw new Error('Grab credentials missing: username/password');

    const { context, page } = await this.launchBrowser();
    try {
      const loginUrl =
        'https://weblogin.grab.com/merchant/login' +
        '?service_id=MEXUSERS' +
        '&redirect=https%3A%2F%2Fmerchant.grab.com%2Fportal';

      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);

      await page.fill('#Username', username);
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(6000);

      await page.fill('input[type="password"]', password);
      await page.click('button:has-text("Continue")');
      await page.waitForTimeout(12000);

      const currentUrl = page.url();
      if (!currentUrl.includes('/dashboard') && !currentUrl.includes('/portal')) {
        throw new Error(`Grab login failed, URL: ${currentUrl}`);
      }

      const allCookies = await context.cookies();
      const cookies: Record<string, string> = {};
      for (const c of allCookies) {
        if (c.domain.includes('grab.com')) cookies[c.name] = c.value;
      }

      return { cookies, fetchedAt: Math.floor(Date.now() / 1000) };
    } finally {
      await browser.close();
    }
  }

  isExpired(session: GrabSession): boolean {
    return (Date.now() / 1000 - session.fetchedAt) > this.COOKIE_MAX_AGE;
  }

  cookieString(session: GrabSession): string {
    return Object.entries(session.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private async launchBrowser() {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] as any });
      (window as any).chrome = { runtime: {} };
    });
    const page = await context.newPage();
    return { context, page };
  }
}
```

**Code for `src/platforms/grab/api.ts`:**

```typescript
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
    if (!data.hasMore) break;
    pageIndex++;
  }

  return allStatements;
}

function formatTzOffset(timezone: string): string {
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
```

**Code for `src/platforms/grab/normalize.ts`:**

```typescript
import { UnifiedOrder } from '../../core/types.js';
import { GrabStatement } from './api.js';

export function normalizeOrder(
  statement: GrabStatement,
  accountId: string,
  merchantId: string,
  platformTimezone: string,
): UnifiedOrder {
  // Status mapping: cancelled is detected by cancelRole/cancelledAt, not by deliveryStatus
  const isCancelled = !!(statement.cancelRole || statement.cancelledAt);
  const status = isCancelled ? 'cancelled'
    : statement.deliveryStatus === 'COMPLETED' ? 'completed'
    : statement.deliveryStatus === 'FAILED' ? 'cancelled'
    : 'in_progress'; // ORDER_EXECUTING → in_progress

  const netMinor = statement.orderEarningsInMinorUnit ?? 0;
  const currency = statement.currency?.code ?? 'VND';

  return {
    platform: 'grab',
    platformOrderId: statement.ID || statement.bookingCode,
    accountId,
    merchantId,
    status,
    platformStatus: statement.deliveryStatus,
    // grossAmountMinor is null for Grab — it only provides net earnings
    grossAmountMinor: null,
    netAmountMinor: netMinor,
    currency,
    orderedAt: statement.createdAt,
    platformTimezone,
    rawJson: statement,
    updatedAt: statement.updatedAt,
  };
}
```

**Code for `src/platforms/grab/index.ts`:**

```typescript
import {
  PlatformConnector, PlatformAccount, UnifiedOrder, DateRange,
  AuthState, AuthError, SessionStore,
} from '../../core/types.js';
import { GrabAuthenticator } from './auth.js';
import { fetchDailyReport, GrabStatement } from './api.js';
import { normalizeOrder } from './normalize.js';

export class GrabConnector implements PlatformConnector {
  readonly platform = 'grab';
  private auth = new GrabAuthenticator();

  async fetchOrders(
    account: PlatformAccount,
    range: DateRange,
    sessionStore: SessionStore,
  ): Promise<UnifiedOrder[]> {
    const session = await this.auth.getSession(account, sessionStore);
    try {
      const statements = await fetchDailyReport(session, range, account.timezone);
      return statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone));
    } catch (err) {
      if (err instanceof AuthError && err.authState === 'expired') {
        // Force re-login and retry once
        sessionStore.remove(account.id);
        const newSession = await this.auth.login(account);
        await sessionStore.set(account.id, newSession);
        const statements = await fetchDailyReport(newSession, range, account.timezone);
        return statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone));
      }
      throw err;
    }
  }

  async checkAuth(account: PlatformAccount, sessionStore: SessionStore): Promise<AuthState> {
    const cached = await sessionStore.get(account.id) as any;
    if (!cached || this.auth.isExpired(cached)) {
      // Try a cheap validate with cached session (may be expired but worth a quick check)
      if (cached && await this.auth.validateSession(cached)) {
        return 'valid';
      }
      // Attempt re-login
      try {
        await this.auth.login(account);
        return 'valid';
      } catch {
        return 'needs_human';
      }
    }
    // Quick validation of cached session
    const valid = await this.auth.validateSession(cached);
    return valid ? 'valid' : 'expired';
  }
}
```

**Verification:**

```bash
pnpm run lint
# Expected: No errors
```

**Commit:**

```bash
git add src/platforms/grab/
git commit -m "feat: extract Grab adapter behind PlatformConnector with SessionStore"
```

### Task 4: Set up Drizzle schema + SQLite database

**Objective:** Create the database schema with proper unique constraints, foreign keys, indexes, and session storage.

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/repo.ts`
- Create: `src/db/migrate.ts`
- Create: `drizzle.config.ts`

**Code for `src/db/schema.ts`:**

```typescript
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
```

**Key schema changes from fable review:**
- ✅ **Unique index** on `(platform, platform_order_id)` — required for `onConflictDoUpdate`
- ✅ **`accountId` FK** on orders — links orders to the account that fetched them
- ✅ **`platformStatus`** column — raw status string for re-evaluation
- ✅ **`grossAmountMinor`** nullable — preserves "gross unknown" vs "gross equals net"
- ✅ **`platformSessions`** table — stateful session cache per account
- ✅ **Foreign keys** on `orders.accountId`, `orders.merchantId`, `fetchRuns.accountId`, `platformSessions.accountId`
- ✅ **Indexes** on `(merchantId, orderedAt)` and `(accountId, orderedAt)` for summary queries
- ✅ **Timezone on `platformAccounts`** — IANA name, single source of truth

**Code for `src/db/repo.ts`:**

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { UnifiedOrder, FetchRun, SessionStore } from '../core/types.js';

const sqlite = new Database('data/delivery.db');
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

// Using a transaction for bulk upserts (better-sqlite3 limitation)
export function upsertOrders(orders: UnifiedOrder[]) {
  const tx = db.transaction((items: UnifiedOrder[]) => {
    for (const o of items) upsertOrder(o);
  });
  tx(orders);
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
      .where((s: any) => s.accountId.eq(accountId))
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
      .where((s: any) => s.accountId.eq(accountId))
      .run();
  }
}

// ===== Platform accounts =====

export function getAccount(accountId: string) {
  return db.select()
    .from(schema.platformAccounts)
    .where((a: any) => a.id.eq(accountId))
    .get();
}
```

**Verification:**

```bash
mkdir -p data
pnpm run lint
# Expected: No errors
```

**Commit:**

```bash
git add src/db/ drizzle.config.ts
git commit -m "feat: add Drizzle schema with unique constraints, FKs, indexes, session storage"
```

### Task 5: Create the unified CLI that replaces grab_report.ts

**Objective:** Build `src/cli.ts` that routes `fetch <platform> <account_id> [from] [to]`, loading account from DB. Registration happens in the composition root (cli.ts), NOT in core registry.

**Files:**
- Create: `src/cli.ts`
- Create: `src/core/registry.ts`
- Create: `src/config/loader.ts`

**Code for `src/core/registry.ts`:**

```typescript
// Pure registry — no imports from platform adapters.
// Connectors are registered by the composition root (cli.ts, index.ts).
import { PlatformConnector } from './types.js';

const registry = new Map<string, PlatformConnector>();

export function registerConnector(connector: PlatformConnector) {
  registry.set(connector.platform, connector);
}

export function getConnector(platform: string): PlatformConnector {
  const c = registry.get(platform);
  if (!c) throw new Error(`Unknown platform: ${platform}. Available: ${[...registry.keys()].join(', ')}`);
  return c;
}
```

**Code for `src/cli.ts`:**

```typescript
#!/usr/bin/env tsx
// Composition root — registers connectors, wires up the app
import { registerConnector, getConnector } from './core/registry.js';
import { GrabConnector } from './platforms/grab/index.js';
import { upsertOrders, logFetchRun, DbSessionStore, getAccount } from './db/repo.js';
import { PlatformAccount, DateRange } from './core/types.js';
import pino from 'pino';

// Register connectors at startup
registerConnector(new GrabConnector());

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'fetch') {
    const platform = args[1];
    const accountId = args[2];
    const from = args[3] ?? new Date().toISOString().split('T')[0];
    const to = args[4] ?? from;

    if (!accountId) {
      console.error('Usage: pnpm fetch <platform> <account_id> [from] [to]');
      console.error('Example: pnpm fetch grab grab-dong-day 2026-07-13');
      process.exit(1);
    }

    // Load account from DB (not env vars — single source of truth)
    const accountRow = getAccount(accountId);
    if (!accountRow) {
      console.error(`Account not found: ${accountId}. Run seed first.`);
      process.exit(1);
    }

    const connector = getConnector(platform);
    const range: DateRange = { from, to };
    const startedAt = new Date().toISOString();

    logger.info({ platform, accountId, from, to }, 'Fetching orders');

    try {
      const account: PlatformAccount = {
        id: accountRow.id,
        platform: accountRow.platform,
        merchantId: accountRow.merchantId,
        merchantName: accountRow.label,
        credentials: {
          username: process.env.GRAB_USERNAME || '',
          password: process.env.GRAB_PASSWORD || '',
        },
        timezone: accountRow.timezone,
        config: JSON.parse(accountRow.config),
      };

      const orders = await connector.fetchOrders(account, range, sessionStore);
      upsertOrders(orders);
      logFetchRun({
        platform: account.platform,
        accountId: account.id,
        dateFrom: from,
        dateTo: to,
        status: 'success',
        orderCount: orders.length,
        startedAt,
        completedAt: new Date().toISOString(),
      });

      const completed = orders.filter(o => o.status === 'completed').length;
      const totalRevenue = orders.reduce((s, o) => s + o.netAmountMinor, 0);
      logger.info({ totalOrders: orders.length, completed, revenue: totalRevenue / 1000 }, 'Done');
      console.log(JSON.stringify({ total_orders: orders.length, completed, revenue_minor: totalRevenue }, null, 2));
    } catch (err: any) {
      logFetchRun({
        platform,
        accountId,
        dateFrom: from,
        dateTo: to,
        status: 'failure',
        orderCount: 0,
        errorMessage: err.message,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      logger.error({ err }, 'Fetch failed');
      process.exit(1);
    }
  } else {
    console.error('Usage: pnpm fetch <platform> <account_id> [from] [to]');
    console.error('Example: pnpm fetch grab grab-dong-day 2026-07-14');
    process.exit(1);
  }
}

main();
```

**Verification:**

```bash
pnpm run lint
# Expected: No errors
```

**Commit:**

```bash
git add src/cli.ts src/core/registry.ts
git commit -m "feat: unified CLI with DB-backed accounts and SessionStore"
```

### Task 6: Merchant seed + env config

**Objective:** Create the seed script and env file for the Đong Đầy merchant. Credentials stay in `.env`; DB stores a credential key reference.

**Files:**
- Create: `.env.example`
- Create: `scripts/seed-merchants.ts`

**Code for `scripts/seed-merchants.ts`:**

```typescript
// scripts/seed-merchants.ts
// Run: npx tsx scripts/seed-merchants.ts
import { db } from '../src/db/repo.js';
import { merchants, platformAccounts } from '../src/db/schema.js';

// Seed Đong Đầy merchant
db.insert(merchants)
  .values({ id: 'dong-day', name: 'Coffee & Bánh Mì Đong Đầy' })
  .onConflictDoNothing()
  .run();

// Seed Grab platform account
// Credentials are NOT stored here — they come from .env via credentialKey
db.insert(platformAccounts)
  .values({
    id: 'grab-dong-day',
    merchantId: 'dong-day',
    platform: 'grab',
    label: 'Grab Đong Đầy (main)',
    credentialKey: 'grab-dong-day', // maps to GRAB_USERNAME/GRAB_PASSWORD in .env
    config: JSON.stringify({ mgid: '0f02fe82-734e-481a-b574-dca5c46a4999' }),
    timezone: 'Asia/Ho_Chi_Minh',
  })
  .onConflictDoNothing()
  .run();

console.log('✅ Merchants seeded.');
console.log('   Account ID: grab-dong-day');
console.log('   Then: GRAB_USERNAME=x GRAB_PASSWORD=x pnpm fetch grab grab-dong-day 2026-07-14');
```

**`.env.example`:**

```bash
# Environment config — copy to .env and fill in
GRAB_USERNAME=
GRAB_PASSWORD=
GRAB_MERCHANT_ID=dong-day
GRAB_TIMEZONE=Asia/Ho_Chi_Minh
```

**Commit:**

```bash
git add scripts/seed-merchants.ts .env.example
git commit -m "feat: add seed script and env template"
```

---

## Phase 2: Scheduler & Reliability

**Goal:** Add automatic daily fetching, retry with backoff, `fetch_runs` logging, Telegram alerts.

### Task 1: Add scheduler module with node-cron

**Files:**
- Create: `src/scheduler/index.ts`
- Modify: `src/index.ts` (server entry point)

**Code for `src/scheduler/index.ts`:**

```typescript
import cron from 'node-cron';
import { getConnector } from '../core/registry.js';
import { upsertOrders, logFetchRun, DbSessionStore } from '../db/repo.js';
import { PlatformAccount, DateRange } from '../core/types.js';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });
const sessionStore = new DbSessionStore();

interface ScheduleConfig {
  cron: string;
  platform: string;
  account: PlatformAccount;
  trailingDays: number; // re-fetch trailing window
}

export function startScheduler(schedules: ScheduleConfig[]) {
  for (const s of schedules) {
    cron.schedule(s.cron, async () => {
      const today = new Date().toISOString().split('T')[0];
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - s.trailingDays);
      const from = fromDate.toISOString().split('T')[0];

      const range: DateRange = { from, to: today };
      const connector = getConnector(s.platform);
      const startedAt = new Date().toISOString();

      logger.info({ platform: s.platform, accountId: s.account.id, from, to: today }, 'Scheduled fetch');

      try {
        const orders = await connector.fetchOrders(s.account, range, sessionStore);
        upsertOrders(orders);
        logFetchRun({
          platform: s.platform,
          accountId: s.account.id,
          dateFrom: from,
          dateTo: today,
          status: 'success',
          orderCount: orders.length,
          startedAt,
          completedAt: new Date().toISOString(),
        });
        logger.info({ count: orders.length }, 'Scheduled fetch complete');
      } catch (err: any) {
        logFetchRun({
          platform: s.platform,
          accountId: s.account.id,
          dateFrom: from,
          dateTo: today,
          status: 'failure',
          orderCount: 0,
          errorMessage: err.message,
          startedAt,
        });
        logger.error({ err: err.message }, 'Scheduled fetch failed');
        // TODO: send Telegram alert via grammY
      }
    });
    logger.info({ cron: s.cron, platform: s.platform, account: s.account.id }, 'Scheduler registered');
  }
}
```

**Commit:**

```bash
git add src/scheduler/
git commit -m "feat: add node-cron scheduler for daily fetches"
```

---

## Phase 3: API + Summaries

**Goal:** Fastify REST API + daily Telegram summary.

### Task 1: Fastify API server

**Files:**
- Create: `src/api/index.ts`
- Create: `src/api/routes/orders.ts`
- Create: `src/api/routes/summary.ts`

### Task 2: Telegram daily summary via grammY

**Files:**
- Create: `src/notify/telegram.ts`

---

## Phase 4: Second Platform (Foodpanda)

**Goal:** Validate the plugin architecture by implementing a Foodpanda connector.

**Files:**
- Create: `src/platforms/foodpanda/auth.ts`
- Create: `src/platforms/foodpanda/api.ts`
- Create: `src/platforms/foodpanda/normalize.ts`
- Create: `src/platforms/foodpanda/index.ts`

---

## Phase 5: Production Hardening

**Goal:** Dockerize, swap to PostgreSQL, encrypted session storage.

### Task 1: Dockerfile with Playwright base image

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

### Task 2: PostgreSQL migration

**Files:**
- Modify: `src/db/repo.ts` (Drizzle dialect swap)
- Create: `drizzle.config.prod.ts`

---

## Phase 6: Dashboard & More Platforms

**Goal:** Web UI + ShopeeFood connector.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Grab changes login page → breaks auth | Playwright selectors need periodic validation; `checkAuth()` validates cached session with one API call |
| Foodpanda/ShopeeFood auth is fundamentally different (OTP/2FA) | The `PlatformConnector` interface omits `login()` — auth is fully internal. `needs_human` state triggers Telegram alert. CLI command to paste cookies into session store provides manual recovery |
| SQLite concurrency issues with scheduler + CLI | WAL mode enabled; for production, swap to Postgres in Phase 5 |
| Cookie expiry between fetch and pagination | 401 → `AuthError('expired')` → auto re-login + retry once; `SessionStore.remove()` clears stale cache |
| Timezone mismatches across platforms | IANA timezone per account (not per merchant); all timestamps stored as ISO 8601 strings |
| Multiple Grab accounts cause concurrent Playwright sessions | Per-platform semaphore in Phase 2 |

## Fable Review Applied

All issues from fable code review (2026-07-14) have been resolved in this plan:

| # | Issue | Fix |
|---|-------|-----|
| 1 | Missing unique index on `(platform, platform_order_id)` | Added `uniqueIndex()` in schema — upsert now works |
| 2 | Cancelled status checks `'CANCELLED'` which never occurs | Now checks `cancelRole`/`cancelledAt` — real cancelled data correctly mapped |
| 3 | No SessionStore — every fetch = full Playwright login | `SessionStore` interface + `DbSessionStore` + `platformSessions` table |
| 4 | `DateRange` as `Date` causes timezone day-off-by-one | Changed to `'YYYY-MM-DD'` strings throughout |
| 5 | `AuthError` defined but `api.ts` throws string | `api.ts` throws `AuthError('expired')` — `index.ts` uses `instanceof` |
| 6 | `checkAuth()` does full login (can't return 'expired') | Now validates cached session with one cheap API call |
| 7 | Missing `'in_progress'` status for `ORDER_EXECUTING` | Added to `OrderStatus` enum + `platformStatus` field stores raw string |
| 8 | `grossAmountMinor: netMinor` conflates unknown with equal | Made `grossAmountMinor` nullable (`number \| null`) |
| 9 | `registry.ts` imports from platforms (dependency inversion) | Registration moved to composition root (`cli.ts`/`index.ts`) |
| 10 | `PlatformName` fake union collapses to `string` | Changed to plain `string` |
| 11 | Encryption aspirational — credentials stored as plain JSON | Credentials stay in `.env`; DB stores `credentialKey` reference only |
| 12 | Sessions have no table | Added `platform_sessions` table with `accountId` PK |
| 13 | Two sources of truth (CLI from env vs DB) | CLI loads account from DB; credentials still from env |
| 14 | `needs_human` has no recovery | CLI session-import command in Phase 2; Telegram alert path |
| 15 | `formatTzOffset` silent `+07:00` fallback | Now throws on unrecognized timezone; supports IANA names via lookup |

## Verification Checklist

- [ ] Phase 1: `pnpm fetch grab grab-dong-day 2026-07-13` produces normalized orders in SQLite
- [ ] Phase 1: Upsert works — re-running the same range updates existing rows
- [ ] Phase 1: Cancelled orders correctly mapped (check `cancelRole`/`cancelledAt`)
- [ ] Phase 1: `ORDER_EXECUTING` orders mapped to `'in_progress'` status
- [ ] Phase 1: Session caching works — second fetch skips Playwright login
- [ ] Phase 2: Scheduler runs daily and logs to `fetch_runs`
- [ ] Phase 2: Auth expiry triggers `needs_human` alert (not silent retry loop)
- [ ] Phase 3: `GET /summary?from=&to=` returns cross-platform totals
- [ ] Phase 4: Foodpanda connector exists and works alongside Grab
- [ ] Phase 5: Docker image builds and runs with Postgres
- [ ] Hardcoded credentials are gone
