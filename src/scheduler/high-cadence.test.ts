/**
 * What the scheduler costs when the SAME failure is rediscovered on every tick.
 *
 * Every other test in this repo asks what one run does. These ask what 480 runs a day
 * do, because that is where a nightly design quietly turns into a login storm, a
 * detail-call storm and a Telegram storm — all three were measured here before they
 * were fixed, through the real connector, the real repo and the real fetch service.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { GrabAuthenticator, GrabSession } from '../platforms/grab/auth.js';
import { GrabConnector } from '../platforms/grab/index.js';
import { LoginGate } from '../core/login-gate.js';
import { ThrottledNotifier } from '../notify/index.js';
import type { Notifier } from '../notify/index.js';
import type { Config } from '../config/index.js';

// Point repo at a temp DB BEFORE importing it (repo opens the DB at module load)
const tmp = mkdtempSync(join(tmpdir(), 'delivery-cadence-test-'));
process.env.DB_PATH = join(tmp, 'test.db');
process.env.GRAB_USERNAME = 'u';
process.env.GRAB_PASSWORD = 'p';

const repo = await import('../db/repo.js');
const { runMigrations } = await import('../db/migrate.js');
const schema = await import('../db/schema.js');
const { registerConnector } = await import('../core/registry.js');
const { runDailyFetch } = await import('./index.js');
const { buildAccount, fetchAndStore } = await import('../core/fetch-service.js');

runMigrations();
repo.db.insert(schema.merchants).values({ id: 'merch-1', name: 'Test Merchant' }).run();
repo.db.insert(schema.platformAccounts).values({
  id: 'acct-1', merchantId: 'merch-1', platform: 'grab', label: 'test', credentialKey: 'k',
  timezone: 'Asia/Ho_Chi_Minh', config: JSON.stringify({ itemDetail: { delayMs: 0 } }),
}).run();

after(() => rmSync(tmp, { recursive: true, force: true }));

const logger = pino({ level: 'silent' });
const sessionStore = new repo.DbSessionStore();
// trailingDays 0 keeps each tick to one day: the cost being counted is per-order, and
// a wider window would only multiply it.
const config = { fetchTrailingDays: 0 } as Config;

/** Counts logins; never launches Chromium. */
class CountingAuth extends GrabAuthenticator {
  logins = 0;
  constructor(private mode: 'works' | 'throws') { super(); }
  override async login(): Promise<GrabSession> {
    this.logins++;
    if (this.mode === 'throws') throw new Error('page.fill: Timeout 30000ms exceeded waiting for "#Username"');
    return { cookies: { session: `n${this.logins}` }, fetchedAt: Math.floor(Date.now() / 1000) };
  }
  override async validateSession() { return false; }
}

class CollectingNotifier implements Notifier {
  readonly enabled = true;
  sent: string[] = [];
  async alert(message: string) { this.sent.push(message); }
}

const TICKS_PER_DAY = 480; // FETCH_CRON every 3 minutes

test('cookies that permanently 401 no longer cost one headless login per tick', async () => {
  // MEASURED BEFORE THE FIX, through this same path: 1 login per tick, stable over five
  // consecutive ticks, and the session state stayed out of 'needs_human' the whole time
  // — so gating on the state was never going to bound it. 480 Chromium launches a day
  // against a live production merchant account is the lockout the budget was written to
  // prevent, arriving through the tick rate.
  const clock = { t: Date.parse('2026-08-07T00:00:00Z') };
  const auth = new CountingAuth('works'); // the login itself is fine; what it returns is not
  registerConnector(new GrabConnector(auth, new LoginGate({ now: () => clock.t })));
  await sessionStore.set('acct-1', { cookies: { session: 'stale' }, fetchedAt: Math.floor(Date.now() / 1000) });

  const globalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
  const notifier = new ThrottledNotifier(new CollectingNotifier(), undefined, 6 * 3_600_000, () => clock.t);
  const inner = (notifier as unknown as { inner: CollectingNotifier }).inner;

  try {
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      await runDailyFetch(config, sessionStore, logger, notifier);
      clock.t += 3 * 60_000;
    }
  } finally {
    globalThis.fetch = globalFetch;
  }

  assert.ok(auth.logins <= 30, `a day of dead cookies must not be a day of logins, got ${auth.logins}`);
  assert.ok(auth.logins >= 5, `…but it must keep trying, got ${auth.logins}`);
  // The same condition, 480 times, is one thing to say — plus a heartbeat when the mute
  // window lapses, so it cannot be forgotten. Two conditions alternate here and both are
  // real: the session Grab hands back is rejected on arrival, and the gate holds the next
  // login. Two × four 6-hour windows in a day is the ceiling.
  assert.ok(inner.sent.length <= 10, `480 ticks must not be 480 Telegram messages, got ${inner.sent.length}`);
  assert.ok(inner.sent.length >= 1, 'and it must be said at least once');
  assert.ok(inner.sent.some(m => /still failing: \d+ more occurrence/.test(m)), 'the repeat count is the heartbeat');
  assert.equal(repo.getSessionState('acct-1'), 'expired');
});

test('a broken login recovers on its own once the platform is healthy', async () => {
  // The other half of "quiet": a bound that never reopens is an outage nobody is
  // paged for. Nothing here is reset by hand — the backoff simply expires.
  //
  // Driven through fetchAndStore, which is what runDailyFetch calls, rather than
  // through runDailyFetch itself: a login that fails with a PLAIN Playwright error is
  // retried once by the scheduler, and this test would then spend the (deliberately
  // short) retry delay on every tick in real seconds. That delay is measured for what
  // it is in scheduler/index.test.ts.
  const clock = { t: Date.parse('2026-08-07T00:00:00Z') };
  const auth = new CountingAuth('throws');
  registerConnector(new GrabConnector(auth, new LoginGate({ now: () => clock.t })));
  await sessionStore.remove('acct-1');

  const globalFetch = globalThis.fetch;
  const statements = [{
    ID: '001652323231-C8C3JTXZJGMTTJ',
    currency: { code: 'VND', symbol: '₫', exponent: '0', exponentUnit: 1 },
    orderEarningsInMinorUnit: 413_534, deliveryStatus: 'COMPLETED',
    createdAt: '2026-08-05T15:38:16Z', updatedAt: '2026-08-05T16:09:19Z',
    bookingCode: 'A-9J73HL8GWNW6AV', priceDisplay: '548.000', displayID: '1',
  }];
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).includes('daily-pagination')) return new Response(JSON.stringify({ statements }));
    return new Response(JSON.stringify({ order: { orderID: 'x' } }));
  }) as typeof fetch;

  const account = buildAccount('acct-1');
  const day = { from: '2026-08-05', to: '2026-08-05' };
  const tick = async () => {
    try { await fetchAndStore(account, day, sessionStore, logger); } catch { /* logged and alerted inside */ }
    clock.t += 3 * 60_000;
  };

  try {
    // An hour of ticks with the login broken.
    for (let i = 0; i < 20; i++) await tick();
    const spentWhileBroken = auth.logins;
    assert.ok(spentWhileBroken <= 5, `an hour of a broken login is a handful of attempts, got ${spentWhileBroken}`);

    // Grab is fixed. No import-session, no restart, no state to clear.
    (auth as unknown as { mode: string }).mode = 'works';
    clock.t += 61 * 60_000;
    await tick();

    assert.equal(auth.logins, spentWhileBroken + 1, 'exactly one login, the moment the gate reopened');
    assert.equal(repo.getSessionState('acct-1'), 'valid', 'and the account is working again on its own');
  } finally {
    globalThis.fetch = globalFetch;
  }
});

test('an order that can never be stored is not a detail call and an alert every tick', async () => {
  // MEASURED BEFORE THE FIX: itemsWritten 1 / itemsSkipped 10 on three consecutive runs
  // with one order's row deleted between them, and a 480-tick simulation that made a
  // detail call on 480 of 480 ticks with 0 rows ever written — plus one Telegram
  // message per tick for the same bad order.
  const clock = { t: Date.parse('2026-08-07T00:00:00Z') };
  registerConnector(new GrabConnector(new CountingAuth('works'), new LoginGate({ now: () => clock.t })));
  await sessionStore.set('acct-1', { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });
  repo.db.delete(schema.orders).run(); // the tests above left rows for the same account

  const details = JSON.parse(
    readFileSync(new URL('../../data/sample-order-details.json', import.meta.url), 'utf8'),
  ).orders as { orderID: string }[];
  const GOOD = details[0].orderID;
  const BAD = details[1].orderID;
  const statement = (id: string, earnings: unknown) => ({
    ID: id,
    currency: { code: 'VND', symbol: '₫', exponent: '0', exponentUnit: 1 },
    orderEarningsInMinorUnit: earnings,
    deliveryStatus: 'COMPLETED',
    createdAt: '2026-08-05T15:38:16Z',
    updatedAt: '2026-08-05T16:09:19Z',
    bookingCode: 'A-9J73HL8GWNW6AV',
    priceDisplay: '548.000',
    displayID: '1',
  });
  // '312.000' where a minor-unit integer belongs — a locale-formatted string is exactly
  // what order-guard refuses, because Number('312.000') is 312 and that is a 1000x error
  // in a NOT NULL money column. The order is therefore never written, so it has no row,
  // so it has no detail_attempted_at, so nothing in the database can hold its cooldown.
  const statements = [statement(GOOD, 413_534), statement(BAD, '312.000')];

  const requested: string[] = [];
  const globalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
    const href = String(url);
    if (href.includes('daily-pagination')) return new Response(JSON.stringify({ statements }));
    const id = decodeURIComponent(href.split('/').pop()!);
    requested.push(id);
    return new Response(JSON.stringify({ order: details.find(o => o.orderID === id) }));
  }) as typeof fetch;

  const notifier = new ThrottledNotifier(new CollectingNotifier(), undefined, 6 * 3_600_000, () => clock.t);
  const inner = (notifier as unknown as { inner: CollectingNotifier }).inner;
  try {
    for (let tick = 0; tick < 60; tick++) {
      await runDailyFetch(config, sessionStore, logger, notifier);
      clock.t += 3 * 60_000;
    }
  } finally {
    globalThis.fetch = globalFetch;
  }

  const badCalls = requested.filter(id => id === BAD).length;
  assert.equal(badCalls, 1, `the unstorable order is called once, not once a tick (got ${badCalls})`);
  assert.equal(requested.filter(id => id === GOOD).length, 1, 'and the storable one settles after its first call');
  assert.equal(
    repo.db.select().from(schema.orders).all().filter(o => o.platformOrderId === BAD).length, 0,
    'it really never got a row — that is the whole reason its clock had to live elsewhere',
  );
  assert.ok(inner.sent.length <= 2, `one bad order is not 60 Telegram messages, got ${inner.sent.length}`);
});
