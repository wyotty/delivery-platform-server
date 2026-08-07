import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NoRowRetryLog, StoredOrderDetail } from '../../core/detail-refresh.js';
import { LoginGate } from '../../core/login-gate.js';
import { AuthError, PlatformAccount, SessionStore } from '../../core/types.js';
import { GrabAuthenticator, GrabSession } from './auth.js';
import { GrabOrder } from './api.js';
import { GrabConnector } from './index.js';

const account: PlatformAccount = {
  id: 'acct-1',
  platform: 'grab',
  merchantId: 'merch-1',
  merchantName: 'Test Merchant',
  credentials: { username: 'u', password: 'p' },
  timezone: 'Asia/Ho_Chi_Minh',
  config: {},
};

class MemoryStore implements SessionStore {
  private sessions = new Map<string, unknown>();
  async get(id: string) { return this.sessions.get(id) ?? null; }
  async set(id: string, s: unknown) { this.sessions.set(id, s); }
  async remove(id: string) { this.sessions.delete(id); }
}

/**
 * Counts logins and never launches a browser. `loginFails` reproduces the real
 * failure: auth.ts raises AuthError only for missing credentials and a bad landing
 * URL, so a changed login page, a CAPTCHA or a `page.fill` timeout arrives as a
 * PLAIN Playwright error.
 */
class FakeAuth extends GrabAuthenticator {
  logins = 0;
  constructor(public loginFails = false) { super(); }
  override async login(): Promise<GrabSession> {
    this.logins++;
    if (this.loginFails) throw new Error('page.fill: Timeout 30000ms exceeded waiting for "#Username"');
    return { cookies: { session: `n${this.logins}` }, fetchedAt: Math.floor(Date.now() / 1000) };
  }
}

/** withAuthRetry is the connector's whole auth path; drive it as the item loop does. */
const callWithAuth = <T>(
  connector: GrabConnector,
  store: SessionStore,
  fn: (s: GrabSession) => Promise<T>,
): Promise<T> =>
  (connector as unknown as {
    withAuthRetry(a: PlatformAccount, s: SessionStore, f: typeof fn): Promise<T>;
  }).withAuthRetry(account, store, fn);

/** A gate on a clock the test drives, so an hour of backoff costs no wall time. */
function gateAt(clock: { t: number }) {
  return new LoginGate({ now: () => clock.t });
}

test('a session revoked mid-run costs one login for the whole run, not one per remaining order', async () => {
  // Grab revokes the session at order 5 of 44. The re-login then fails with a plain
  // Playwright error, which the item loop treats as "one bad order" and continues —
  // leaving the session store empty. Every later order used to reach a login hidden
  // inside getSession(), uncounted: 44 headless Chromium launches against a live
  // production merchant account, and a run that still said 'success'.
  const clock = { t: Date.now() };
  const auth = new FakeAuth(true);
  const connector = new GrabConnector(auth, gateAt(clock));
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  let detailCalls = 0;
  let authErrors = 0;

  for (let order = 0; order < 20; order++) {
    try {
      await callWithAuth(connector, store, async () => {
        detailCalls++;
        throw new AuthError('expired', 'Grab session expired'); // the 401 api.ts maps
      });
    } catch (err) {
      // Exactly the item loop's catch: AuthError aborts the day, anything else is
      // recorded on the order and the loop moves on.
      if (err instanceof AuthError) authErrors++;
    }
  }

  assert.equal(auth.logins, 1, 'one failed login puts the account in backoff for the rest of the run');
  assert.ok(authErrors > 0, 'once the gate is closed the failure surfaces as AuthError, which aborts the run');
  assert.equal(detailCalls, 1, 'and no further detail call goes out on a dead session');
});

test('a cached session that dies mid-run is replaced by exactly one login', async () => {
  const clock = { t: Date.now() };
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth, gateAt(clock));
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  let expired = true;
  const result = await callWithAuth(connector, store, async (s: GrabSession) => {
    if (expired) { expired = false; throw new AuthError('expired', 'Grab session expired'); }
    return s.cookies.session;
  });

  assert.equal(result, 'n1', 'the retry runs against the fresh session, not the dead one');
  assert.equal(auth.logins, 1);
  // Persisted, so the next call in the same run reuses it instead of logging in again.
  assert.deepEqual((await store.get(account.id) as GrabSession).cookies, { session: 'n1' });
  // The fresh session worked, so nothing is held against the account.
  assert.equal(auth.logins, 1);
});

test('a login whose session is rejected on first use counts as a FAILED login', async () => {
  // The measured permanently-401 case: login() succeeds every single time, and what it
  // returns is refused immediately. Nothing throws from the login itself, so a gate
  // that only watched for broken logins would never back off — one Chromium launch per
  // tick, 480 a day, for as long as the cookies stay rejected.
  const clock = { t: Date.now() };
  const auth = new FakeAuth();
  const gate = gateAt(clock);
  const connector = new GrabConnector(auth, gate);
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  await assert.rejects(
    () => callWithAuth(connector, store, async () => { throw new AuthError('expired', '401'); }),
    AuthError,
  );

  assert.equal(auth.logins, 1);
  assert.equal(gate.snapshot(account.id).consecutiveFailures, 1, 'a session dead on arrival is a failed login');
  assert.ok(gate.snapshot(account.id).blockedForMs > 0, 'and the next tick backs off instead of logging in again');
});

test('a cached session costs no login at all', async () => {
  const clock = { t: Date.now() };
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth, gateAt(clock));
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  for (let i = 0; i < 44; i++) {
    assert.equal(await callWithAuth(connector, store, async s => s.cookies.session), 'live');
  }
  assert.equal(auth.logins, 0, 'the ordinary tick never launches a browser');
});

test('a broken login is quiet within one tick and recovers on its own', async () => {
  // The bound that matters is across TICKS, not within one: the scheduler process is
  // long-lived and calls this 480 times a day. Five minutes of ticks, then the platform
  // comes back.
  const clock = { t: Date.parse('2026-08-07T00:00:00Z') };
  const auth = new FakeAuth(true);
  const connector = new GrabConnector(auth, gateAt(clock));
  const store = new MemoryStore();

  const tick = async () => {
    try {
      await callWithAuth(connector, store, async (s: GrabSession) => s.cookies.session);
    } catch { /* the scheduler logs it and moves on */ }
  };

  // 5 minutes at a 3-minute cadence: ticks at 0 and 3 minutes.
  await tick();
  clock.t += 3 * 60_000;
  await tick();
  assert.equal(auth.logins, 1, 'the second tick is inside the 5-minute backoff and never launches a browser');

  // 6 minutes in, the first backoff step has expired: exactly one more attempt.
  clock.t += 3 * 60_000;
  await tick();
  assert.equal(auth.logins, 2);
  clock.t += 3 * 60_000;
  await tick();
  assert.equal(auth.logins, 2, 'and then it is quiet again, on the longer step');

  // The platform recovers. Nothing had to be reset by hand — the backoff simply expires.
  auth.loginFails = false;
  clock.t += 16 * 60_000;
  await tick();
  assert.equal(auth.logins, 3);
  assert.deepEqual((await store.get(account.id) as GrabSession).cookies, { session: 'n3' });
});

// ===== the detail phase, end to end =====

const fixture: GrabOrder = JSON.parse(
  readFileSync(new URL('../../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders.find((o: GrabOrder) => o.orderID === '001652323231-C8C3JTXZJGMTTJ');

const statement = {
  ID: fixture.orderID,
  currency: { code: 'VND', symbol: '₫', exponent: '0', exponentUnit: 1 },
  orderEarningsInMinorUnit: 413_534,
  deliveryStatus: 'COMPLETED',
  createdAt: '2026-08-05T15:38:16Z',
  updatedAt: '2026-08-05T16:09:19Z',
  bookingCode: 'A-9J73HL8GWNW6AV',
  priceDisplay: '548.000',
  displayID: '1',
};

test('the detail response body reaches the order untouched', async (t) => {
  t.after(() => mock.restoreAll());
  // The seam the whole feature rests on: whatever Grab answered has to arrive at
  // UnifiedOrder.detailRawJson as those bytes, because repo.ts stores it as-is.
  // The two things a re-encode would change are both in this body on purpose — an
  // int64 orderFlags, and the unicode escape Grab's encoder writes '&' as.
  const { orderFlags: _rounded, ...fields } = fixture;
  const body = `{"order":{"orderFlags":4035792627008804869,"note":"a \\u0026 b",${JSON.stringify(fields).slice(1)}}`;

  mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) =>
    new Response(String(url).includes('daily-pagination') ? JSON.stringify({ statements: [statement] }) : body));

  const connector = new GrabConnector(new FakeAuth());
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  const orders = await connector.fetchOrders(
    { ...account, config: { itemDetail: { delayMs: 0 } } },
    { from: '2026-08-05', to: '2026-08-05' },
    store,
  );

  assert.equal(orders.length, 1);
  assert.equal(orders[0].detailRawJson, body, 'byte for byte, not a re-serialization');
  assert.equal(orders[0].itemsError, undefined);
  // The projections are still built off the same payload, from the statement's own
  // declared exponent: '32.000' is 32000 đồng.
  assert.equal(orders[0].items?.length, 5);
  assert.equal(orders[0].fare?.deliveryFeeMinor, 32000);
});

test("the daily statement's own int64 reaches the order unrounded", async (t) => {
  t.after(() => mock.restoreAll());
  // The statement is the other half of what gets stored, and it has an orderFlags of
  // its own. It has no verbatim body to keep — orders.raw_json holds ONE element of
  // {"statements":[…]} and repo.ts re-serializes it — so the report parse is where
  // the digits are kept or lost. resp.json() lost them on all 21 statements of a
  // live day, in the same row as an intact detail payload.
  const FLAGS = '4035788216077387780'; // live, 001578008445-C8C3KBJWGYE2JN
  const dailyBody = `{"statements":[{"orderFlags":${FLAGS},${JSON.stringify(statement).slice(1)}]}`;

  mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) =>
    new Response(String(url).includes('daily-pagination') ? dailyBody : JSON.stringify({ order: fixture })));

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    { ...account, config: { itemDetail: { delayMs: 0 } } },
    { from: '2026-08-05', to: '2026-08-05' },
    new MemoryStore(),
  );

  assert.equal(orders.length, 1);
  // JSON.stringify is what repo.ts does to this object on its way into raw_json.
  assert.match(JSON.stringify(orders[0].rawJson), new RegExp(`"orderFlags":${FLAGS}[,}]`));
  assert.doesNotMatch(JSON.stringify(orders[0].rawJson), /4035788216077388000/);
  // …and the ordinary fields the normalizer reads are still ordinary values.
  assert.equal(orders[0].netAmountMinor, 413_534);
  assert.equal(orders[0].status, 'completed');
  assert.equal(orders[0].currency, 'VND');
});

// ===== incremental detail fetching =====
//
// The daily report is one call per day and always runs; the per-order detail calls
// are the ~1 req/sec that made a high-cadence tick impossible. Every test below counts
// the detail calls that actually went out over the wire.

const details: GrabOrder[] = JSON.parse(
  readFileSync(new URL('../../../data/sample-order-details.json', import.meta.url), 'utf8'),
).orders;

const ORDER_A = '001652323231-C8C3JTXZJGMTTJ';
const ORDER_B = '001510457039-C8C3KEBVELCJVT';
const UPDATED_A = '2026-08-05T16:09:19Z';
const UPDATED_B = '2026-08-05T17:22:41Z';

const statementFor = (id: string, updatedAt: string) => ({ ...statement, ID: id, updatedAt });

/**
 * Serves the two-order day, and records which order details were actually requested.
 * Returns the live array so a test can assert on it after the fetch.
 */
function mockGrabDay(t: { after(fn: () => void): void }, statements: unknown[]): string[] {
  const requested: string[] = [];
  t.after(() => mock.restoreAll());
  mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (href.includes('daily-pagination')) return new Response(JSON.stringify({ statements }));
    const id = decodeURIComponent(href.split('/').pop()!);
    requested.push(id);
    const order = details.find(o => o.orderID === id);
    if (!order) throw new Error(`no fixture for ${id}`);
    return new Response(JSON.stringify({ order }));
  });
  return requested;
}

/** What the DB holds for an order whose lines are current as of `updatedAt`. */
const current = (updatedAt: string): StoredOrderDetail => ({
  updatedAt,
  detailUpdatedAt: updatedAt,
  detailAttemptedAt: new Date().toISOString(),
  itemsSuspect: null,
  rejected: false,
});

const twoOrderDay = [statementFor(ORDER_A, UPDATED_A), statementFor(ORDER_B, UPDATED_B)];

const liveSession = async () => {
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });
  return store;
};

/** delayMs 0 everywhere except the pacing test, which is about the delay itself. */
const incremental = (stored: Map<string, StoredOrderDetail>, delayMs = 0) => ({
  storedDetail: (_reportDate: string) => stored,
  account: { ...account, config: { itemDetail: { delayMs } } },
});

test('an unchanged order costs no detail call at all', async (t) => {
  // Both orders are exactly as stored: 44 of these a tick, 480 ticks a day.
  const requested = mockGrabDay(t, twoOrderDay);
  const stored = new Map([[ORDER_A, current(UPDATED_A)], [ORDER_B, current(UPDATED_B)]]);
  const { storedDetail, account: acct } = incremental(stored);

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    acct, { from: '2026-08-05', to: '2026-08-05' }, await liveSession(), { storedDetail },
  );

  assert.deepEqual(requested, [], 'not one detail request went out');
  assert.equal(orders.length, 2, 'and the order-level data is still complete');
  // Neither a payload nor an error — that pair is what repo.ts reads as "leave every
  // row this order owns exactly as it is".
  for (const o of orders) {
    assert.equal(o.items, undefined);
    assert.equal(o.itemsError, undefined);
    assert.equal(o.detailRawJson, undefined);
    assert.equal(o.fare, undefined);
    assert.equal(o.status, 'completed', 'status and money still come off the daily report every tick');
  }
});

test('a changed updatedAt re-fetches that order and only that order', async (t) => {
  const requested = mockGrabDay(t, twoOrderDay);
  const stored = new Map([
    // A moved on since we stored it; B did not.
    [ORDER_A, { ...current(UPDATED_A), updatedAt: '2026-08-05T15:00:00Z', detailUpdatedAt: '2026-08-05T15:00:00Z' }],
    [ORDER_B, current(UPDATED_B)],
  ]);
  const { storedDetail, account: acct } = incremental(stored);

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    acct, { from: '2026-08-05', to: '2026-08-05' }, await liveSession(), { storedDetail },
  );

  assert.deepEqual(requested, [ORDER_A]);
  const a = orders.find(o => o.platformOrderId === ORDER_A)!;
  assert.equal(a.items?.length, 5, 'the re-fetched order has its fresh lines');
  assert.ok(a.detailRawJson, 'and the payload they came out of');
  assert.equal(orders.find(o => o.platformOrderId === ORDER_B)!.items, undefined);
});

test('an order the store has never seen is fetched', async (t) => {
  const requested = mockGrabDay(t, twoOrderDay);
  // B has just been placed: no row for it anywhere.
  const { storedDetail, account: acct } = incremental(new Map([[ORDER_A, current(UPDATED_A)]]));

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    acct, { from: '2026-08-05', to: '2026-08-05' }, await liveSession(), { storedDetail },
  );

  assert.deepEqual(requested, [ORDER_B]);
  assert.equal(orders.find(o => o.platformOrderId === ORDER_B)!.items?.length, 2);
});

test('--force re-fetches everything, however current the store believes it is', async (t) => {
  // fetch-service omits storedDetail entirely for --force, so the connector is back to
  // the behaviour it had before any of this existed. That is the property being pinned:
  // after a parser fix, re-pulling history must still be possible.
  const requested = mockGrabDay(t, twoOrderDay);

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    { ...account, config: { itemDetail: { delayMs: 0 } } },
    { from: '2026-08-05', to: '2026-08-05' },
    await liveSession(),
    {}, // no storedDetail — the --force path
  );

  assert.deepEqual(requested.sort(), [ORDER_B, ORDER_A].sort(), 'every order, unchanged or not');
  assert.equal(orders.filter(o => o.items).length, 2);
});

test('the day is looked up once, not once per order', async (t) => {
  // At a 3-minute cadence a per-order SELECT is the cost that hides until the window
  // widens. The lookup takes a business day and hands back the whole day's rows.
  const requested = mockGrabDay(t, twoOrderDay);
  const lookups: string[] = [];
  const stored = new Map([[ORDER_A, current(UPDATED_A)], [ORDER_B, current(UPDATED_B)]]);

  await new GrabConnector(new FakeAuth()).fetchOrders(
    { ...account, config: { itemDetail: { delayMs: 0 } } },
    { from: '2026-08-04', to: '2026-08-05' },
    await liveSession(),
    { storedDetail: (reportDate) => { lookups.push(reportDate); return stored; } },
  );

  assert.deepEqual(lookups, ['2026-08-04', '2026-08-05'], 'one lookup per day in the range, whatever the order count');
  assert.deepEqual(requested, []);
});

test('skipped orders cost none of the pacing delay either', async (t) => {
  // The delay is what makes a full day 45 seconds. Sleeping once per ORDER rather than
  // once between CALLS would keep every second of that while skipping the requests —
  // a tick that still takes 44 seconds to do nothing.
  const requested = mockGrabDay(t, twoOrderDay);
  const stored = new Map([[ORDER_A, current(UPDATED_A)]]); // B is new, A is unchanged
  const { storedDetail, account: acct } = incremental(stored, 5_000);

  const started = Date.now();
  await new GrabConnector(new FakeAuth()).fetchOrders(
    acct, { from: '2026-08-05', to: '2026-08-05' }, await liveSession(), { storedDetail },
  );
  const elapsed = Date.now() - started;

  assert.deepEqual(requested, [ORDER_B]);
  assert.ok(elapsed < 2_000, `one call, no pacing: took ${elapsed}ms`);
});

test('an order the store can never keep is not fetched on every tick', async (t) => {
  // The order-guard rejects it, so it never gets a row, so getStoredOrderDetail never
  // returns it, so the rule says 'new' — every tick, forever. Measured through the real
  // repo: 480 detail calls on 480 ticks with 0 rows written. Here the store simply
  // never learns about ORDER_B, which is that condition exactly.
  const requested = mockGrabDay(t, twoOrderDay);
  const stored = new Map([[ORDER_A, current(UPDATED_A)]]);
  const connector = new GrabConnector(new FakeAuth());
  const store = await liveSession();
  const acct = { ...account, config: { itemDetail: { delayMs: 0, retryMissingAfterMs: 900_000 } } };

  for (let tick = 0; tick < 5; tick++) {
    await connector.fetchOrders(acct, { from: '2026-08-05', to: '2026-08-05' }, store, {
      storedDetail: () => stored,
    });
  }

  assert.deepEqual(requested, [ORDER_B], '5 ticks, one call — the rowless clock held');
});

test('the rowless cooldown expires, so a transient write failure still heals', async (t) => {
  // The other half of the bound: it must not become "never again". A log with a clock
  // the test drives, so 15 minutes costs no wall time.
  const requested = mockGrabDay(t, twoOrderDay);
  const stored = new Map([[ORDER_A, current(UPDATED_A)]]);
  const connector = new GrabConnector(new FakeAuth(), new LoginGate(), new NoRowRetryLog());
  const store = await liveSession();
  const acct = { ...account, config: { itemDetail: { delayMs: 0, retryMissingAfterMs: 1 } } };

  await connector.fetchOrders(acct, { from: '2026-08-05', to: '2026-08-05' }, store, { storedDetail: () => stored });
  await new Promise(r => setTimeout(r, 5));
  await connector.fetchOrders(acct, { from: '2026-08-05', to: '2026-08-05' }, store, { storedDetail: () => stored });

  assert.deepEqual(requested, [ORDER_B, ORDER_B], 'once the cooldown lapses it is tried again');
});

test('the detail deadline bounds the whole call, not each day of it', async (t) => {
  // Per day, the same number meant "5 minutes × the trailing window", which at
  // FETCH_TRAILING_DAYS=2 is 15 minutes — five ticks of the overlap guard held by one
  // account, and a bound that moved whenever the window did.
  //
  // Three days of two DISTINCT orders (an order belongs to exactly one business day),
  // each detail call made to cost 40ms against a 50ms budget: spent once for the run,
  // that is at most two calls in total; re-armed per day, it is at least one on each of
  // the three days however slow the machine is.
  t.after(() => mock.restoreAll());
  const byDay: Record<string, string[]> = {
    '2026-08-03': [details[0].orderID, details[1].orderID],
    '2026-08-04': [details[2].orderID, details[3].orderID],
    '2026-08-05': [details[4].orderID, details[5].orderID],
  };
  const requested: string[] = [];
  mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (href.includes('daily-pagination')) {
      const date = new URL(href).searchParams.get('startTime')!.slice(0, 10);
      return new Response(JSON.stringify({
        statements: byDay[date].map(id => statementFor(id, UPDATED_A)),
      }));
    }
    const id = decodeURIComponent(href.split('/').pop()!);
    requested.push(id);
    await new Promise(r => setTimeout(r, 40));
    return new Response(JSON.stringify({ order: details.find(o => o.orderID === id) }));
  });

  const orders = await new GrabConnector(new FakeAuth()).fetchOrders(
    { ...account, config: { itemDetail: { delayMs: 0, deadlineMs: 50 } } },
    { from: '2026-08-03', to: '2026-08-05' }, // three days
    await liveSession(),
    { storedDetail: () => new Map() },
  );

  assert.ok(requested.length <= 2, `the deadline is spent once for the run, not once per day (made ${requested.length} calls)`);
  // Every order the run intended to fetch and did not reach says so, on all three days —
  // that is what puts them on the retry clock instead of losing them silently.
  assert.equal(orders.length, 6);
  assert.ok(orders.filter(o => o.itemsError === 'detail phase deadline exceeded').length >= 4);
});

test('a non-auth error is never spent on a login', async () => {
  const clock = { t: Date.now() };
  const auth = new FakeAuth();
  const gate = gateAt(clock);
  const connector = new GrabConnector(auth, gate);
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  await assert.rejects(
    () => callWithAuth(connector, store, async () => { throw new Error('Grab API error: HTTP 500'); }),
    /HTTP 500/,
  );
  assert.equal(auth.logins, 0);
  assert.equal(gate.snapshot(account.id).attemptsInWindow, 0, 'an HTTP 500 is not evidence about the login');
});

test('a placeholder session row is not a session', async () => {
  // setSessionState writes {} with fetchedAt 0 when auth breaks. That object is truthy
  // and not "expired" by any arithmetic on an undefined timestamp, so it used to be
  // handed to the API client as a usable session: one request per tick carrying an
  // empty cookie header, 480 guaranteed 401s a day, before anything else could happen.
  const clock = { t: Date.now() };
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth, gateAt(clock));
  const store = new MemoryStore();
  await store.set(account.id, {}); // exactly what setSessionState persists

  let calls = 0;
  const used = await callWithAuth(connector, store, async (s: GrabSession) => { calls++; return s.cookies.session; });

  assert.equal(calls, 1, 'the call is made once, against a real session');
  assert.equal(used, 'n1');
  assert.equal(auth.logins, 1, 'the placeholder sent us straight to a login instead of a doomed request');
});
