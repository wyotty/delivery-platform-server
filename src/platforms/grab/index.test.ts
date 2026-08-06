import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError, PlatformAccount, SessionStore } from '../../core/types.js';
import { GrabAuthenticator, GrabSession } from './auth.js';
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
  constructor(private loginFails = false) { super(); }
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
  budget: { logins: number },
  fn: (s: GrabSession) => Promise<T>,
): Promise<T> =>
  (connector as unknown as {
    withAuthRetry(a: PlatformAccount, s: SessionStore, b: { logins: number }, f: typeof fn): Promise<T>;
  }).withAuthRetry(account, store, budget, fn);

test('a session revoked mid-run costs the budgeted logins, not one per remaining order', async () => {
  // Grab revokes the session at order 5 of 44. The budgeted re-login then fails with
  // a plain Playwright error, which the item loop treats as "one bad order" and
  // continues — leaving the session store empty. Every later order used to reach a
  // login hidden inside getSession(), uncounted: 44 headless Chromium launches
  // against a live production merchant account, and a run that still said 'success'.
  const auth = new FakeAuth(true);
  const connector = new GrabConnector(auth);
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  const budget = { logins: 2 };
  let detailCalls = 0;
  let authErrors = 0;

  for (let order = 0; order < 20; order++) {
    try {
      await callWithAuth(connector, store, budget, async () => {
        detailCalls++;
        throw new AuthError('expired', 'Grab session expired'); // the 401 api.ts maps
      });
    } catch (err) {
      // Exactly the item loop's catch: AuthError aborts the day, anything else is
      // recorded on the order and the loop moves on.
      if (err instanceof AuthError) authErrors++;
    }
  }

  assert.equal(auth.logins, 2, 'the whole run may spend two headless logins, no matter how many orders');
  assert.equal(budget.logins, 0);
  assert.ok(authErrors > 0, 'once the budget is spent the failure surfaces as AuthError, which aborts the run');
  assert.equal(detailCalls, 1, 'and no further detail call goes out on a dead session');
});

test('a cold start plus one mid-run expiry is the normal two-login case', async () => {
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth);
  const store = new MemoryStore(); // nothing cached: the run must log in once to start

  const budget = { logins: 2 };
  let expired = true;
  const result = await callWithAuth(connector, store, budget, async (s: GrabSession) => {
    if (expired) { expired = false; throw new AuthError('expired', 'Grab session expired'); }
    return s.cookies.session;
  });

  assert.equal(result, 'n2', 'the retry runs against the fresh session, not the dead one');
  assert.equal(auth.logins, 2);
  assert.equal(budget.logins, 0);
  // Persisted, so the next call in the same run reuses it instead of logging in again.
  assert.deepEqual((await store.get(account.id) as GrabSession).cookies, { session: 'n2' });
});

test('a cached session costs no login at all', async () => {
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth);
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  const budget = { logins: 2 };
  for (let i = 0; i < 44; i++) {
    assert.equal(await callWithAuth(connector, store, budget, async s => s.cookies.session), 'live');
  }
  assert.equal(auth.logins, 0, 'the ordinary night never launches a browser');
  assert.equal(budget.logins, 2);
});

test('a non-auth error is never spent on a login', async () => {
  const auth = new FakeAuth();
  const connector = new GrabConnector(auth);
  const store = new MemoryStore();
  await store.set(account.id, { cookies: { session: 'live' }, fetchedAt: Math.floor(Date.now() / 1000) });

  const budget = { logins: 2 };
  await assert.rejects(
    () => callWithAuth(connector, store, budget, async () => { throw new Error('Grab API error: HTTP 500'); }),
    /HTTP 500/,
  );
  assert.equal(auth.logins, 0);
  assert.equal(budget.logins, 2);
});
