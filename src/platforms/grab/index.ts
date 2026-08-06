import type { Logger } from 'pino';
import { z } from 'zod';
import {
  PlatformConnector, PlatformAccount, UnifiedOrder, DateRange,
  AuthState, AuthError, SessionStore, FetchOrdersOptions, attachPartialOrders,
} from '../../core/types.js';
import { eachDate } from '../../core/dates.js';
import { GrabAuthenticator, GrabSession } from './auth.js';
import { fetchDailyReport, fetchOrderDetail } from './api.js';
import { normalizeOrder, normalizeOrderItems } from './normalize.js';
import { grabCurrencyExponent } from './money.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Per-order detail fetching, tuned per account through platform_accounts.config —
 * an existing JSON column, so `enabled: false` is a one-UPDATE kill switch at 2am
 * when Grab starts 403-ing the endpoint, with no redeploy and no env change.
 */
const ItemDetailSchema = z.object({
  enabled: z.boolean().default(true),
  /** ~1 req/sec is what was verified against the live API. Never fire these in parallel. */
  delayMs: z.number().int().min(0).max(10_000).default(1000),
  requestTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  /** Hard stop for one day's detail phase, so a slow night cannot run into the next tick. */
  deadlineMs: z.number().int().min(0).max(3_600_000).default(300_000),
});

type ItemDetailConfig = z.infer<typeof ItemDetailSchema>;

function itemDetailConfig(account: PlatformAccount, logger?: Logger): ItemDetailConfig {
  const parsed = ItemDetailSchema.safeParse(account.config?.itemDetail ?? {});
  if (parsed.success) return parsed.data;
  // A typo in a hand-edited config must not take the nightly fetch down with it.
  logger?.warn({ accountId: account.id, issues: parsed.error.issues }, 'Invalid itemDetail config, using defaults');
  return ItemDetailSchema.parse({});
}

// Grab order IDs look like '001652323231-C8C3JTXZJGMTTJ'; booking codes look like
// 'A-9J73HL8GWNW6AV'. normalizeOrder falls back to the booking code when a
// statement has no ID, and the detail endpoint is keyed on the order ID only.
const ORDER_ID_SHAPE = /^\d{6,}-[A-Z0-9]+$/;

/**
 * Headless-login allowance for one fetchOrders call — EVERY login, not just the
 * ones a retry asks for.
 *
 * api.ts maps every 401 to 'expired', and it cannot tell a real expiry from
 * throttling. Without a budget, a rate-limited Grab would drive one full headless
 * Playwright login per order: ~130 logins a night against a live production
 * account, which is exactly the lockout the scheduler's withRetry comment warns
 * about.
 *
 * Two per run: one to establish a session, one to recover from it dying mid-run.
 * The cap only holds because `login()` below is the single place this connector
 * launches a browser — a login hidden inside a "get me a session" helper is
 * uncounted, and the per-order catch below (a Playwright failure is not an
 * AuthError) would then keep the loop running, spending one such login on every
 * remaining order while the run still reported success.
 */
const LOGINS_PER_RUN = 2;

interface LoginBudget { logins: number }

interface OneDayResult {
  orders: UnifiedOrder[];
  /** Auth broke mid-detail-phase: stop calling, but the orders above are still real. */
  abort?: AuthError;
}

export class GrabConnector implements PlatformConnector {
  readonly platform = 'grab';

  // Injectable so the login cap can be tested without launching Chromium. The
  // default is the only thing production ever passes.
  constructor(private auth: GrabAuthenticator = new GrabAuthenticator()) {}

  async fetchOrders(
    account: PlatformAccount,
    range: DateRange,
    sessionStore: SessionStore,
    opts: FetchOrdersOptions = {},
  ): Promise<UnifiedOrder[]> {
    const { logger } = opts;
    const detail = itemDetailConfig(account, logger);
    const budget: LoginBudget = { logins: LOGINS_PER_RUN };

    // One request per day, never one request for the whole range: Grab decides a
    // statement's business day server-side, so the requested day is the only
    // reliable way to know which report an order belongs to. A multi-day request
    // would collapse that attribution.
    const orders: UnifiedOrder[] = [];
    for (const date of eachDate(range.from, range.to)) {
      let day: OneDayResult;
      try {
        day = await this.fetchOneDay(account, date, sessionStore, budget, detail, logger);
      } catch (err) {
        // Days already fetched are real data — day 3 failing must not discard them.
        throw attachPartialOrders(err, orders);
      }
      orders.push(...day.orders);
      if (day.abort) throw attachPartialOrders(day.abort, orders);
    }
    return orders;
  }

  private async fetchOneDay(
    account: PlatformAccount,
    date: string,
    sessionStore: SessionStore,
    budget: LoginBudget,
    detail: ItemDetailConfig,
    logger?: Logger,
  ): Promise<OneDayResult> {
    const day: DateRange = { from: date, to: date };
    const statements = await this.withAuthRetry(account, sessionStore, budget,
      s => fetchDailyReport(s, day, account.timezone));

    // Order-level data is complete before the first detail call goes out, and it is
    // returned even when the detail phase aborts.
    const orders = statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone, date));
    if (!detail.enabled) return { orders };

    // ponytail: every order in the trailing window is re-fetched every night, so
    // ~2/3 of these calls re-confirm terminal orders. Passing the stored
    // updated_at down from fetch-service (which has the DB) would cut it to ~44.
    const deadline = Date.now() + detail.deadlineMs;
    for (const [i, order] of orders.entries()) {
      if (Date.now() > deadline) {
        for (const rest of orders.slice(i)) rest.itemsError = 'detail phase deadline exceeded';
        logger?.warn({ date, fetched: i, total: orders.length }, 'Item detail deadline exceeded');
        break;
      }
      if (i > 0) await sleep(detail.delayMs);

      if (!ORDER_ID_SHAPE.test(order.platformOrderId)) {
        order.itemsError = `Not a Grab order ID, refusing detail lookup: ${order.platformOrderId}`;
        continue;
      }

      try {
        const raw = await this.withAuthRetry(account, sessionStore, budget,
          s => fetchOrderDetail(s, order.platformOrderId, detail.requestTimeoutMs));
        const { items, suspect } = normalizeOrderItems(
          raw, order.platformOrderId, grabCurrencyExponent(statements[i]),
        );
        order.items = items;
        if (suspect) {
          order.itemsSuspect = suspect;
          logger?.warn({ orderId: order.platformOrderId, suspect }, 'Item payload failed its completeness checks');
        }
      } catch (err) {
        if (err instanceof AuthError) {
          // withAuthRetry already spent the re-login. A second auth failure is the
          // session dying mid-run, not one bad order: stop calling, hand back what
          // we have, and let fetchAndStore mark the session and alert.
          logger?.warn({ date, fetched: i, total: orders.length }, 'Auth broke during item detail — aborting detail phase');
          return { orders, abort: err };
        }
        // One order's items lost; the other 43 and every order-level field survive.
        order.itemsError = err instanceof Error ? err.message : String(err);
        logger?.warn({ orderId: order.platformOrderId, err }, 'Order detail fetch failed');
      }
    }

    return { orders };
  }

  /**
   * Run one authenticated call, re-logging in once if the session turns out to be
   * dead. Both the report and the per-order detail calls go through here, so there
   * is exactly one auth path — and re-reading the session each time means a
   * mid-run re-login is picked up by every call after it.
   */
  private async withAuthRetry<T>(
    account: PlatformAccount,
    sessionStore: SessionStore,
    budget: LoginBudget,
    fn: (session: GrabSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.session(account, sessionStore, budget);
    try {
      return await fn(session);
    } catch (err) {
      if (!(err instanceof AuthError) || err.authState !== 'expired') throw err;
      await sessionStore.remove(account.id);
      return await fn(await this.login(account, sessionStore, budget));
    }
  }

  /** The cached session, or a budgeted login. Never produces one off the books. */
  private async session(
    account: PlatformAccount,
    sessionStore: SessionStore,
    budget: LoginBudget,
  ): Promise<GrabSession> {
    const cached = await this.auth.getCachedSession(account, sessionStore);
    return cached ?? await this.login(account, sessionStore, budget);
  }

  /**
   * The ONLY place this connector launches a browser, so the budget is a real cap.
   *
   * An exhausted budget raises AuthError rather than logging in again: the detail
   * loop reads that as "the session died mid-run", aborts the day and hands the
   * orders back, which makes fetchAndStore mark the session and alert. Without
   * that, a login failing with a plain Playwright error (a changed login page, a
   * CAPTCHA, a `page.fill` timeout — auth.ts only raises AuthError for missing
   * credentials and a bad landing URL) is caught per order as "one bad order", and
   * the run finishes reporting success with no session state and no alert.
   */
  private async login(
    account: PlatformAccount,
    sessionStore: SessionStore,
    budget: LoginBudget,
  ): Promise<GrabSession> {
    if (budget.logins <= 0) {
      throw new AuthError('expired', `Grab session expired again after re-login (${LOGINS_PER_RUN} logins spent this run)`);
    }
    budget.logins--;
    const fresh = await this.auth.login(account);
    await sessionStore.set(account.id, fresh);
    return fresh;
  }

  async checkAuth(account: PlatformAccount, sessionStore: SessionStore): Promise<AuthState> {
    const cached = await sessionStore.get(account.id) as GrabSession | null;
    if (!cached || this.auth.isExpired(cached)) {
      // Try a cheap validate with cached session (may be expired but worth a quick check)
      if (cached && await this.auth.validateSession(cached)) {
        return 'valid';
      }
      // Attempt re-login — persist the session so the next fetchOrders reuses it
      try {
        const s = await this.auth.login(account);
        await sessionStore.set(account.id, s);
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
