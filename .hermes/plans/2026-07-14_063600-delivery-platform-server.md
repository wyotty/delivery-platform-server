# delivery-platform-server Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan phase by phase.

**Goal:** Build a unified server that aggregates order/report data from multiple food delivery platforms (Grab, Foodpanda, ShopeeFood, etc.) into a single storage + API surface.

**Architecture:** Modular monolith with a platform-adapter plugin layer. Each platform (Grab, Foodpanda, …) is a self-contained adapter behind a minimal `PlatformConnector` interface. Auth is fully encapsulated inside each adapter. No microservices, no message queue — one deployable process until proven otherwise.

**Tech Stack:** TypeScript (Node 22 + tsx), pnpm, Drizzle ORM (SQLite dev → Postgres prod), Fastify API, zod validation, node-cron scheduling, Playwright for browser-auth platforms, grammY for Telegram, pino for logging.

**Repo:** `https://github.com/wyotty/delivery-platform-server`

**Claude Code fable recommended language:** TypeScript — because Playwright (the load-bearing dependency) is TypeScript-first, all future platform adapters involve the same shape of work (browser automation + JSON wrangling), and types can be shared with a future web dashboard.

---

## Phase 1: Extract & Restructure

**Goal:** Scaffold the repo, port `grab_report.ts` into the platform-adapter pattern, verify the CLI workflow fully replaces the old script.

### Task 1: Initialize pnpm monorepo scaffold

**Objective:** Set up the project skeleton with pnpm, tsx, TypeScript config, and dev tooling.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `pnpm-workspace.yaml` (if monorepo; single package is fine for now)

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

### Task 2: Define core types (UnifiedOrder, PlatformConnector, shared types)

**Objective:** Define the unified data model and the `PlatformConnector` interface that all adapters implement.

**Files:**
- Create: `src/core/types.ts`

**Code:**

```typescript
// src/core/types.ts

export type PlatformName = 'grab' | 'foodpanda' | 'shopeefood' | string;

export type OrderStatus = 'completed' | 'cancelled' | 'refunded' | 'other';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface PlatformAccount {
  id: string;
  platform: PlatformName;
  merchantId: string;
  merchantName: string;
  credentials: Record<string, string>; // opaque per-platform
  timezone: string;
  config: Record<string, unknown>;
}

export interface UnifiedOrder {
  platform: PlatformName;
  platformOrderId: string;
  merchantId: string;
  status: OrderStatus;
  grossAmountMinor: number;
  netAmountMinor: number;
  currency: string;
  orderedAt: Date;          // UTC
  platformTimezone: string; // original timezone of the order
  rawJson: unknown;         // original platform payload for re-normalization
  updatedAt: Date;          // UTC, when the platform last reported this order
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

export interface PlatformConnector {
  readonly platform: PlatformName;
  /** Fetch orders in the given date range. Throws AuthError if auth expired/broken. */
  fetchOrders(account: PlatformAccount, range: DateRange): Promise<UnifiedOrder[]>;
  /** Check current auth state without fetching orders. */
  checkAuth(account: PlatformAccount): Promise<AuthState>;
}

export interface FetchRun {
  id?: number;
  platform: PlatformName;
  accountId: string;
  dateFrom: Date;
  dateTo: Date;
  status: 'success' | 'failure' | 'partial';
  orderCount: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}
```

**Step 1: Write the file**

```bash
# Write src/core/types.ts with the code above
```

**Step 2: Verify compilation**

```bash
pnpm run lint
# Expected: No errors
```

**Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat: define core types and PlatformConnector interface"
```

### Task 3: Extract Grab adapter behind PlatformConnector

**Objective:** Split `grab_report.ts` into `platforms/grab/auth.ts`, `api.ts`, `normalize.ts`, `index.ts` behind the interface.

**Files:**
- Create: `src/platforms/grab/auth.ts`
- Create: `src/platforms/grab/api.ts`
- Create: `src/platforms/grab/normalize.ts`
- Create: `src/platforms/grab/index.ts`

**Key principles:**
- Strip hardcoded credentials (`GRAB_USERNAME`, `GRAB_PASSWORD`)
- Credentials come from `PlatformAccount.credentials`
- Cookie cache stored in DB (encrypted), not filesystem `.grab_cookies.json`
- Timezone is per-account config field, not hardcoded `+07:00`
- The existing login flow logic is preserved but refactored into methods

**Code for `src/platforms/grab/auth.ts`:**

```typescript
import { chromium, type Cookie, type BrowserContext } from 'playwright';
import { PlatformAccount, AuthState } from '../../core/types.js';

export interface GrabSession {
  cookies: Record<string, string>;
  fetchedAt: number; // unix seconds
}

export class GrabAuthenticator {
  private readonly COOKIE_MAX_AGE = 3 * 3600; // 3 hours

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
      await context.close();
      await page.context().browser()?.close();
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
import { DateRange } from '../../core/types.js';

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

  const formatDate = (d: Date) => d.toISOString().split('T')[0];
  const startTime = `${formatDate(range.from)}T00:00:00${formatTzOffset(timezone)}`;
  const endTime = `${formatDate(range.to)}T23:59:59${formatTzOffset(timezone)}`;

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
      if (resp.status === 401) throw new Error('AUTH_EXPIRED');
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
  // Parse timezone offset. For now assume +HH:MM format.
  // TODO: use a proper timezone lib for IANA names like "Asia/Ho_Chi_Minh"
  const match = timezone.match(/^([+-]\d{2}):?(\d{2})$/);
  if (match) return `${match[1]}:${match[2]}`;
  return '+07:00'; // fallback
}
```

**Code for `src/platforms/grab/normalize.ts`:**

```typescript
import { UnifiedOrder } from '../../core/types.js';
import { GrabStatement } from './api.js';

export function normalizeOrder(
  statement: GrabStatement,
  merchantId: string,
  platformTimezone: string,
): UnifiedOrder {
  const status = statement.deliveryStatus === 'COMPLETED' ? 'completed'
    : statement.deliveryStatus === 'CANCELLED' ? 'cancelled'
    : 'other';

  const netMinor = statement.orderEarningsInMinorUnit ?? 0;
  const currency = statement.currency?.code ?? 'VND';

  return {
    platform: 'grab',
    platformOrderId: statement.ID || statement.bookingCode,
    merchantId,
    status,
    grossAmountMinor: netMinor, // Grab only provides net currently
    netAmountMinor: netMinor,
    currency,
    orderedAt: new Date(statement.createdAt),
    platformTimezone,
    rawJson: statement,
    updatedAt: new Date(statement.updatedAt),
  };
}
```

**Code for `src/platforms/grab/index.ts`:**

```typescript
import { PlatformConnector, PlatformAccount, UnifiedOrder, DateRange, AuthState, AuthError } from '../../core/types.js';
import { GrabAuthenticator } from './auth.js';
import { fetchDailyReport } from './api.js';
import { normalizeOrder } from './normalize.js';

export class GrabConnector implements PlatformConnector {
  readonly platform = 'grab';
  private auth = new GrabAuthenticator();

  async fetchOrders(account: PlatformAccount, range: DateRange): Promise<UnifiedOrder[]> {
    const session = await this.auth.login(account); // TODO: use cached session
    try {
      const statements = await fetchDailyReport(session, range, account.timezone);
      return statements.map(s => normalizeOrder(s, account.merchantId, account.timezone));
    } catch (err: any) {
      if (err.message === 'AUTH_EXPIRED') {
        const newSession = await this.auth.login(account);
        const statements = await fetchDailyReport(newSession, range, account.timezone);
        return statements.map(s => normalizeOrder(s, account.merchantId, account.timezone));
      }
      throw err;
    }
  }

  async checkAuth(account: PlatformAccount): Promise<AuthState> {
    try {
      const session = await this.auth.login(account);
      return this.auth.isExpired(session) ? 'expired' : 'valid';
    } catch {
      return 'needs_human';
    }
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
git commit -m "feat: extract Grab adapter behind PlatformConnector interface"
```

### Task 4: Set up Drizzle schema + SQLite database

**Objective:** Create the database schema (orders, merchants, platform_accounts, fetch_runs) and migration system.

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/repo.ts`
- Create: `src/db/migrate.ts`
- Create: `drizzle.config.ts`

**Code for `src/db/schema.ts`:**

```typescript
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const orders = sqliteTable('orders', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  platformOrderId: text('platform_order_id').notNull(),
  merchantId: text('merchant_id').notNull(),
  status: text('status').notNull().$type<'completed' | 'cancelled' | 'refunded' | 'other'>(),
  grossAmountMinor: integer('gross_amount_minor').notNull(),
  netAmountMinor: integer('net_amount_minor').notNull(),
  currency: text('currency').notNull(),
  orderedAt: text('ordered_at').notNull(),
  platformTimezone: text('platform_timezone').notNull(),
  updatedAt: text('updated_at').notNull(),
  rawJson: text('raw_json').notNull(), // JSON string
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
});

export const merchants = sqliteTable('merchants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('+07:00'),
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
});

export const platformAccounts = sqliteTable('platform_accounts', {
  id: text('id').primaryKey(),
  merchantId: text('merchant_id').notNull().references(() => merchants.id),
  platform: text('platform').notNull(),
  label: text('label').notNull(),
  credentials: text('credentials').notNull(), // encrypted JSON
  config: text('config').notNull().$default(() => '{}'), // JSON
  createdAt: text('created_at').notNull().$default(() => new Date().toISOString()),
});

export const fetchRuns = sqliteTable('fetch_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  platform: text('platform').notNull(),
  accountId: text('account_id').notNull(),
  dateFrom: text('date_from').notNull(),
  dateTo: text('date_to').notNull(),
  status: text('status').notNull().$type<'success' | 'failure' | 'partial'>(),
  orderCount: integer('order_count').notNull().default(0),
  errorMessage: text('error_message'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});
```

**Code for `src/db/repo.ts`:**

```typescript
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { UnifiedOrder, FetchRun } from '../core/types.js';

const sqlite = new Database('data/delivery.db');
sqlite.pragma('journal_mode = WAL');
export const db = drizzle(sqlite, { schema });

export function upsertOrder(order: UnifiedOrder) {
  db.insert(schema.orders)
    .values({
      platform: order.platform,
      platformOrderId: order.platformOrderId,
      merchantId: order.merchantId,
      status: order.status,
      grossAmountMinor: order.grossAmountMinor,
      netAmountMinor: order.netAmountMinor,
      currency: order.currency,
      orderedAt: order.orderedAt.toISOString(),
      platformTimezone: order.platformTimezone,
      updatedAt: order.updatedAt.toISOString(),
      rawJson: JSON.stringify(order.rawJson),
    })
    .onConflictDoUpdate({
      target: [schema.orders.platform, schema.orders.platformOrderId],
      set: {
        status: order.status,
        netAmountMinor: order.netAmountMinor,
        grossAmountMinor: order.grossAmountMinor,
        updatedAt: order.updatedAt.toISOString(),
        rawJson: JSON.stringify(order.rawJson),
      },
    })
    .run();
}

// Note: better-sqlite3 doesn't support multi-row insert with onConflictDoUpdate.
// Use a transaction for bulk upserts.
export function upsertOrders(orders: UnifiedOrder[]) {
  const tx = db.transaction((items: UnifiedOrder[]) => {
    for (const o of items) upsertOrder(o);
  });
  tx(orders);
}

export function logFetchRun(run: FetchRun) {
  db.insert(schema.fetchRuns)
    .values({
      platform: run.platform,
      accountId: run.accountId,
      dateFrom: run.dateFrom.toISOString(),
      dateTo: run.dateTo.toISOString(),
      status: run.status,
      orderCount: run.orderCount,
      errorMessage: run.errorMessage ?? null,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    })
    .run();
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
git commit -m "feat: add Drizzle schema + SQLite repo with upsert support"
```

### Task 5: Create the unified CLI that replaces grab_report.ts

**Objective:** Build `src/cli.ts` that routes `fetch <platform> [from] [to]` to the right connector.

**Files:**
- Create: `src/cli.ts`
- Create: `src/core/registry.ts`
- Create: `src/config/loader.ts`

**Code for `src/core/registry.ts`:**

```typescript
import { PlatformConnector } from './types.js';
import { GrabConnector } from '../platforms/grab/index.js';

const registry = new Map<string, PlatformConnector>();

export function registerConnector(connector: PlatformConnector) {
  registry.set(connector.platform, connector);
}

export function getConnector(platform: string): PlatformConnector {
  const c = registry.get(platform);
  if (!c) throw new Error(`Unknown platform: ${platform}. Available: ${[...registry.keys()].join(', ')}`);
  return c;
}

// Register built-in platforms
registerConnector(new GrabConnector());
```

**Code for `src/cli.ts`:**

```typescript
#!/usr/bin/env tsx
import { getConnector } from './core/registry.js';
import { upsertOrders, logFetchRun } from './db/repo.js';
import { PlatformAccount, DateRange } from './core/types.js';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'fetch') {
    const platform = args[1];
    const from = args[2] ? new Date(args[2]) : new Date();
    const to = args[3] ? new Date(args[3]) : new Date();

    const connector = getConnector(platform);

    // TODO: load account from config/DB
    const account: PlatformAccount = {
      id: 'default',
      platform,
      merchantId: process.env.GRAB_MERCHANT_ID || 'default',
      merchantName: 'Default Merchant',
      credentials: {
        username: process.env.GRAB_USERNAME || '',
        password: process.env.GRAB_PASSWORD || '',
      },
      timezone: process.env.GRAB_TIMEZONE || '+07:00',
      config: {},
    };

    const range: DateRange = { from, to };
    const startedAt = new Date();

    logger.info({ platform, from, to }, 'Fetching orders');

    try {
      const orders = await connector.fetchOrders(account, range);
      upsertOrders(orders);
      logFetchRun({
        platform,
        accountId: account.id,
        dateFrom: from,
        dateTo: to,
        status: 'success',
        orderCount: orders.length,
        startedAt,
        completedAt: new Date(),
      });

      // Summary output (keeps the old script's behavior)
      const completed = orders.filter(o => o.status === 'completed').length;
      const totalRevenue = orders.reduce((s, o) => s + o.netAmountMinor, 0);
      logger.info({ totalOrders: orders.length, completed, revenue: totalRevenue / 1000 }, 'Done');
      console.log(JSON.stringify({ total_orders: orders.length, completed, revenue_minor: totalRevenue }, null, 2));
    } catch (err: any) {
      logFetchRun({
        platform,
        accountId: account.id,
        dateFrom: from,
        dateTo: to,
        status: 'failure',
        orderCount: 0,
        errorMessage: err.message,
        startedAt,
        completedAt: new Date(),
      });
      logger.error({ err }, 'Fetch failed');
      process.exit(1);
    }
  } else {
    console.error('Usage: pnpm fetch <platform> [from] [to]');
    console.error('Example: pnpm fetch grab 2026-07-14');
    process.exit(1);
  }
}

main();
```

**Verification:**

```bash
pnpm run lint
# Test with a small date range (will need valid credentials)
# GRAB_USERNAME=x GRAB_PASSWORD=x pnpm fetch grab 2026-07-13 2026-07-13
```

**Commit:**

```bash
git add src/cli.ts src/core/registry.ts
git commit -m "feat: unified CLI with platform routing"
```

### Task 6: Port merchant config from old script

**Objective:** Copy `.grab_cookies.json` reference, remove hardcoded credentials, document config setup.

**Files:**
- Create: `data/config.example.yaml` (or use zod-validated JSON in DB)
- Modify: `.gitignore` to exclude `data/delivery.db` and `.env`

**Step 1: Add to .gitignore**

```bash
cat >> .gitignore << 'EOF'

# Data
data/delivery.db
data/delivery.db-wal
data/delivery.db-shm
data/*.json

# Credentials
.env
.grab_cookies.json
EOF
```

**Step 2: Documentation note**

Add to `README.md` (initial version):
```markdown
# delivery-platform-server

Unified delivery platform data aggregator.

## Quick Start

```bash
pnpm install
cp .env.example .env  # fill in credentials
pnpm fetch grab 2026-07-14
```

See `.hermes/plans/2026-07-14_delivery-platform-server.md` for full architecture.
```

**Commit:**

```bash
git add .gitignore README.md
git commit -m "chore: add .gitignore, initial README"
```

### Task 7: Port the old script's merchant data

**Objective:** Save merchant info for Đong Đầy into the merchants table.

**Files:**
- Modify: `src/db/schema.ts` (already done)
- Create: `scripts/seed-merchants.ts`

**Step 1: Create seed script**

```typescript
// scripts/seed-merchants.ts
import { db } from '../src/db/repo.js';
import { merchants, platformAccounts } from '../src/db/schema.js';

// Seed Đong Đầy merchant
db.insert(merchants)
  .values({ id: 'dong-day', name: 'Coffee & Bánh Mì Đong Đầy', timezone: '+07:00' })
  .onConflictDoNothing()
  .run();

db.insert(platformAccounts)
  .values({
    id: 'grab-dong-day',
    merchantId: 'dong-day',
    platform: 'grab',
    label: 'Grab Đong Đầy (main)',
    credentials: JSON.stringify({ username: '', password: '' }), // fill from .env
    config: JSON.stringify({ mgid: '0f02fe82-734e-481a-b574-dca5c46a4999' }),
  })
  .onConflictDoNothing()
  .run();

console.log('Merchants seeded.');
```

**Commit:**

```bash
git add scripts/seed-merchants.ts
git commit -m "feat: add seed script for Đong Đầy merchant"
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
import { upsertOrders, logFetchRun } from '../db/repo.js';
import pino from 'pino';

const logger = pino({ transport: { target: 'pino-pretty' } });

interface ScheduleConfig {
  cron: string;        // e.g. '0 6 * * *' (6am daily)
  platform: string;
  account: any;        // PlatformAccount
  trailingDays: number; // re-fetch trailing window
}

export function startScheduler(schedules: ScheduleConfig[]) {
  for (const s of schedules) {
    cron.schedule(s.cron, async () => {
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - s.trailingDays);

      const connector = getConnector(s.platform);
      logger.info({ platform: s.platform, from, to: now }, 'Scheduled fetch');

      try {
        const orders = await connector.fetchOrders(s.account, { from, to: now });
        upsertOrders(orders);
        logFetchRun({
          platform: s.platform,
          accountId: s.account.id,
          dateFrom: from,
          dateTo: now,
          status: 'success',
          orderCount: orders.length,
          startedAt: new Date(),
          completedAt: new Date(),
        });
        logger.info({ count: orders.length }, 'Scheduled fetch complete');
      } catch (err: any) {
        logFetchRun({
          platform: s.platform,
          accountId: s.account.id,
          dateFrom: from,
          dateTo: now,
          status: 'failure',
          orderCount: 0,
          errorMessage: err.message,
          startedAt: new Date(),
        });
        logger.error({ err: err.message }, 'Scheduled fetch failed');
        // TODO: send Telegram alert
      }
    });
    logger.info({ cron: s.cron, platform: s.platform }, 'Scheduler registered');
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
| Grab changes login page → breaks auth | Playwright selectors need periodic validation; add a `checkAuth()` health check cron |
| Foodpanda/ShopeeFood auth is fundamentally different | The `PlatformConnector` interface deliberately omits `login()` — auth is fully internal to each adapter |
| SQLite concurrency issues with scheduler + CLI | Use WAL mode (already set); for production, swap to Postgres in Phase 5 |
| Cookie expiry between fetch and pagination | Already handled: auth retry on 401, serialized Playwright access |
| Timezone mismatches across platforms | Store `platformTimezone` per order; all `orderedAt` in UTC; re-fetch trailing 3d window |
| Multiple Grab accounts cause concurrent Playwright sessions | Add per-platform semaphore in Phase 2 |

## Verification Checklist

- [ ] Phase 1: `pnpm fetch grab 2026-07-13` produces normalized orders in SQLite
- [ ] Phase 1: Old `grab_report.ts` is fully replaced by the new CLI
- [ ] Phase 2: Scheduler runs daily and logs to `fetch_runs`
- [ ] Phase 2: Auth expiry triggers `needs_human` alert (not silent retry loop)
- [ ] Phase 3: `GET /summary?from=&to=` returns cross-platform totals
- [ ] Phase 4: Foodpanda connector exists and works alongside Grab
- [ ] Phase 5: Docker image builds and runs with Postgres
- [ ] Hardcoded credentials are gone (Phase 1, Task 3)
