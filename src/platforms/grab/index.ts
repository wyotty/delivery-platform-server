import type { Logger } from 'pino';
import { z } from 'zod';
import {
  PlatformConnector, PlatformAccount, UnifiedOrder, DateRange,
  AuthState, AuthError, SessionStore, FetchOrdersOptions, attachPartialOrders,
} from '../../core/types.js';
import { eachDate } from '../../core/dates.js';
import { DetailFetchReason, NoRowRetryLog, detailFetchReason } from '../../core/detail-refresh.js';
import { LoginGate } from '../../core/login-gate.js';
import { GrabAuthenticator, GrabSession } from './auth.js';
import { fetchDailyReport, fetchOrderDetail } from './api.js';
import { normalizeOrder, normalizeOrderFare, normalizeOrderItems } from './normalize.js';
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
  /**
   * Hard stop for the detail phase of ONE fetchOrders call — the whole range, not one
   * day of it.
   *
   * Per day was the same number meaning something else: at FETCH_TRAILING_DAYS=2 that
   * is three days, so the old 300_000 default bounded a run at 15 minutes — five ticks
   * at a 3-minute cadence, with the overlap guard held the whole time and every tick
   * inside it logged and lost. Worse, the bound moved whenever the window did.
   *
   * 120_000 fits inside a 3-minute tick with room for the per-day report calls and the
   * scheduler's short retry. It is also comfortably more than a legitimate cold start
   * costs: measured live at 880 ms per detail call including the 1 req/sec pacing
   * (~136 calls in 120 s), against a 3-day window that held 49 orders on 2026-08-05..07
   * — so the first tick after a deploy or a migration, the one that re-verifies every
   * order in the window, is ~45 s. When a run does exceed the deadline, the orders it
   * did not reach are marked `itemsError` and land on the retryMissingAfterMs clock, so
   * the backlog drains in waves (measured: 300 orders in 33 minutes, every other tick
   * in that window costing nothing) instead of restarting from the top every tick.
   */
  deadlineMs: z.number().int().min(0).max(3_600_000).default(120_000),
  // The two retry clocks for orders that are NOT changing but whose stored lines are
  // missing or doubtful. Defaults and reasoning: core/detail-refresh.ts RetryCooldowns.
  // Here rather than in env because they are a property of one merchant's data, and
  // platform_accounts.config is already the per-account dial that needs no redeploy.
  retryMissingAfterMs: z.number().int().min(0).max(86_400_000).default(900_000),
  retrySuspectAfterMs: z.number().int().min(0).max(604_800_000).default(86_400_000),
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

interface OneDayResult {
  orders: UnifiedOrder[];
  /** Auth broke mid-detail-phase: stop calling, but the orders above are still real. */
  abort?: AuthError;
}

export class GrabConnector implements PlatformConnector {
  readonly platform = 'grab';

  /**
   * Both of these are PROCESS-level state, and that is the whole point of them living
   * on the connector: the composition roots build one instance and the scheduler ticks
   * against it 480 times a day, so anything an individual run remembers is forgotten
   * before it can bound anything. Injectable so the tests can drive their clocks.
   */
  constructor(
    private auth: GrabAuthenticator = new GrabAuthenticator(),
    private loginGate: LoginGate = new LoginGate(),
    private noRowRetry: NoRowRetryLog = new NoRowRetryLog(),
  ) {}

  async fetchOrders(
    account: PlatformAccount,
    range: DateRange,
    sessionStore: SessionStore,
    opts: FetchOrdersOptions = {},
  ): Promise<UnifiedOrder[]> {
    const { logger } = opts;
    const detail = itemDetailConfig(account, logger);
    // ONE deadline for the whole call. Per day, it multiplied by the width of the
    // trailing window and stopped being a bound on how long a tick takes.
    const deadline = Date.now() + detail.deadlineMs;

    // One request per day, never one request for the whole range: Grab decides a
    // statement's business day server-side, so the requested day is the only
    // reliable way to know which report an order belongs to. A multi-day request
    // would collapse that attribution.
    const orders: UnifiedOrder[] = [];
    for (const date of eachDate(range.from, range.to)) {
      let day: OneDayResult;
      try {
        day = await this.fetchOneDay(account, date, sessionStore, deadline, detail, opts);
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
    deadline: number,
    detail: ItemDetailConfig,
    opts: FetchOrdersOptions,
  ): Promise<OneDayResult> {
    const { logger } = opts;
    const day: DateRange = { from: date, to: date };
    const statements = await this.withAuthRetry(account, sessionStore,
      s => fetchDailyReport(s, day, account.timezone));

    // Order-level data is complete before the first detail call goes out, and it is
    // returned even when the detail phase aborts. This half is one call for the whole
    // day and is what makes a 3-minute tick affordable at all: status, amounts and
    // updatedAt are refreshed for every order on every tick, and only the per-order
    // payloads below are rationed.
    const orders = statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone, date));
    if (!detail.enabled) return { orders };

    // ONE query for the day, then a pure decision per order — see
    // core/detail-refresh.ts. `storedDetail` absent = the --force path: fetch all of
    // them, exactly as this loop always did.
    const stored = opts.storedDetail?.(date);
    const now = Date.now();
    // Free to do here: an entry older than the cooldown would be claimed anyway, so
    // dropping it changes no decision and caps the map at one cooldown's worth of orders.
    this.noRowRetry.prune(now, detail.retryMissingAfterMs);
    const reasons: Partial<Record<DetailFetchReason, number>> = {};
    // Indices into `orders`, so `statements[i]` stays index-aligned below — the
    // statement is where the currency exponent that decodes '32.000' comes from.
    const plan: number[] = [];
    let skipped = 0;
    let refused = 0;

    for (const [i, order] of orders.entries()) {
      let reason = stored
        ? detailFetchReason(order.updatedAt, stored.get(order.platformOrderId), now, detail)
        : 'forced';
      // 'new' means "the store has no row for this order", and for an order the writer
      // REFUSES that is permanently true: unstorableReason rejects it before any row
      // exists, so detail_attempted_at — the clock every other retry here is measured
      // against — can never be stamped, and this order asks to be fetched on every tick
      // for as long as it stays in the trailing window. Measured: 480 calls on 480
      // ticks, 0 rows written. The rowless clock is the only thing that can bound it,
      // and it is the same 15-minute clock a stored-but-missing detail gets.
      if (reason === 'new'
        && !this.noRowRetry.claim(`${account.id}/${order.platformOrderId}`, now, detail.retryMissingAfterMs)) {
        reason = null;
      }
      // Skipped: no items, no itemsError, nothing written. The stored rows and their
      // items_fetched_at are left exactly as they are.
      if (!reason) { skipped++; continue; }
      reasons[reason] = (reasons[reason] ?? 0) + 1;

      // After the decision, not before it: this order can never be fetched, so
      // announcing that every single tick would mean a 'partial' run and a fresh
      // itemsError 480 times a day for one booking-code-only statement. Recording it
      // as an attempt puts it on the same cooldown as any other detail that produced
      // no payload, so it is still reported — just not on a loop.
      if (!ORDER_ID_SHAPE.test(order.platformOrderId)) {
        order.itemsError = `Not a Grab order ID, refusing detail lookup: ${order.platformOrderId}`;
        refused++;
        continue;
      }
      plan.push(i);
    }

    if (plan.length === 0) {
      logger?.debug({ date, total: orders.length, skipped, refused }, 'No order detail to fetch');
      return { orders };
    }
    logger?.info(
      { date, total: orders.length, fetching: plan.length, skipped, refused, reasons },
      'Fetching order detail',
    );

    for (const [k, i] of plan.entries()) {
      const order = orders[i];
      if (Date.now() > deadline) {
        // Only the orders this run intended to fetch. Marking a skipped order would
        // report an order nobody looked at as one whose detail is missing.
        for (const rest of plan.slice(k)) orders[rest].itemsError = 'detail phase deadline exceeded';
        logger?.warn({ date, fetched: k, planned: plan.length }, 'Item detail deadline exceeded');
        break;
      }
      // Between calls, not between orders: with 43 of 44 orders skipped, sleeping per
      // order would spend 43 seconds pacing requests that are never made — and pacing
      // is the entire reason a tick has to stay short.
      if (k > 0) await sleep(detail.delayMs);

      try {
        const payload = await this.withAuthRetry(account, sessionStore,
          s => fetchOrderDetail(s, order.platformOrderId, detail.requestTimeoutMs));
        // The statement's own declared exponent, not a guess and not a constant:
        // it is what makes '32.000' thirty-two thousand here and thirty-two there.
        const exponent = grabCurrencyExponent(statements[i]);
        const { items, suspect } = normalizeOrderItems(payload.order, order.platformOrderId, exponent);
        // Assigned only after normalizeOrderItems has vetted the payload — it throws
        // on a mismatched order id or empty items, and a payload that failed those
        // checks must not be stored as this order's raw truth. The three move as one
        // unit from here on: repo.ts writes them in a single statement.
        order.items = items;
        // The body, not the parse of it — see UnifiedOrder.detailRawJson.
        order.detailRawJson = payload.raw;
        // Eight of the twelve fare figures have no *_display column, so a NULL from
        // a format change is indistinguishable from Grab's '' / '-' "none" sentinel
        // in the row itself. This is the only moment it can be said out loud; after
        // it, finding one means a json_extract over the stored payload. Fires for a
        // string the parser refuses AND for a field that stopped being sent
        // ('(absent)'), never for a sentinel — see normalizeOrderFare.
        order.fare = normalizeOrderFare(payload.order, exponent, (field, display) =>
          logger?.warn(
            { orderId: order.platformOrderId, field, display },
            'Grab fare figure unreadable — column stored as NULL',
          ));
        if (suspect) {
          order.itemsSuspect = suspect;
          logger?.warn({ orderId: order.platformOrderId, suspect }, 'Item payload failed its completeness checks');
        }
      } catch (err) {
        if (err instanceof AuthError) {
          // withAuthRetry already spent the re-login. A second auth failure is the
          // session dying mid-run, not one bad order: stop calling, hand back what
          // we have, and let fetchAndStore mark the session and alert.
          logger?.warn({ date, fetched: k, planned: plan.length }, 'Auth broke during item detail — aborting detail phase');
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
    fn: (session: GrabSession) => Promise<T>,
  ): Promise<T> {
    const cached = await this.auth.getCachedSession(account, sessionStore);
    if (!cached) return await this.onFreshSession(account, await this.login(account, sessionStore), fn);
    try {
      return await fn(cached);
    } catch (err) {
      // A cached session dying says nothing about whether logging in works, so it is
      // NOT reported to the gate — only the outcome of a session we just minted is.
      if (!(err instanceof AuthError) || err.authState !== 'expired') throw err;
      await sessionStore.remove(account.id);
      return await this.onFreshSession(account, await this.login(account, sessionStore), fn);
    }
  }

  /**
   * The first call made on a session that was just minted — and therefore the only
   * honest verdict on that login.
   *
   * A login that returns cookies has not succeeded at anything yet. The measured
   * permanently-401 case is exactly this shape: `login()` works every single time and
   * the session it hands back is rejected on first use, so a gate that only watched
   * for thrown logins would never back off and would spend one Chromium launch per
   * tick forever. Rejected-on-first-use is a failed login, and is reported as one.
   */
  private async onFreshSession<T>(
    account: PlatformAccount,
    session: GrabSession,
    fn: (session: GrabSession) => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn(session);
      this.loginGate.succeeded(account.id);
      return result;
    } catch (err) {
      if (err instanceof AuthError) this.loginGate.failed(account.id);
      throw err;
    }
  }

  /**
   * The ONLY place this connector launches a browser, so the gate is a real cap.
   *
   * A refused login raises AuthError('expired') rather than logging in again: the
   * detail loop reads that as "the session died mid-run", aborts the day and hands the
   * orders back, which makes fetchAndStore record the session state and alert (once —
   * the notifier throttles a repeating condition). Without that, a login failing with
   * a plain Playwright error (a changed login page, a CAPTCHA, a `page.fill` timeout —
   * auth.ts only raises AuthError for missing credentials and a bad landing URL) is
   * caught per order as "one bad order", and the run finishes reporting success with
   * no session state and no alert.
   *
   * 'expired' and never 'needs_human': needs_human makes the scheduler skip the
   * account entirely until someone runs `pnpm cli import-session`, which would turn a
   * platform outage into a permanent outage. A gated account still fetches every
   * order-level field (that runs on the cached session or not at all) and starts
   * logging in again the moment the gate reopens.
   */
  private async login(account: PlatformAccount, sessionStore: SessionStore): Promise<GrabSession> {
    const refused = this.loginGate.take(account.id);
    if (refused) throw new AuthError('expired', `Grab login held back — ${refused}`);

    let fresh: GrabSession;
    try {
      fresh = await this.auth.login(account);
    } catch (err) {
      // Counted here as well as in onFreshSession, because this is the branch a plain
      // Playwright error takes and nothing downstream would ever see it as an auth
      // problem — that is precisely how it stayed invisible at 3 logins a tick.
      this.loginGate.failed(account.id);
      throw err;
    }
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
      // Attempt re-login — through login(), so this path cannot launch a browser the
      // gate never counted. A refused login lands in the same catch as a broken one.
      try {
        await this.login(account, sessionStore);
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
