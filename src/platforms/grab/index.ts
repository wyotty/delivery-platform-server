import {
  PlatformConnector, PlatformAccount, UnifiedOrder, DateRange,
  AuthState, AuthError, SessionStore,
} from '../../core/types.js';
import { eachDate } from '../../core/dates.js';
import { GrabAuthenticator, GrabSession } from './auth.js';
import { fetchDailyReport } from './api.js';
import { normalizeOrder } from './normalize.js';

export class GrabConnector implements PlatformConnector {
  readonly platform = 'grab';
  private auth = new GrabAuthenticator();

  async fetchOrders(
    account: PlatformAccount,
    range: DateRange,
    sessionStore: SessionStore,
  ): Promise<UnifiedOrder[]> {
    // One request per day, never one request for the whole range: Grab decides a
    // statement's business day server-side, so the requested day is the only
    // reliable way to know which report an order belongs to. A multi-day request
    // would collapse that attribution.
    const orders: UnifiedOrder[] = [];
    for (const date of eachDate(range.from, range.to)) {
      orders.push(...await this.fetchOneDay(account, date, sessionStore));
    }
    return orders;
  }

  private async fetchOneDay(
    account: PlatformAccount,
    date: string,
    sessionStore: SessionStore,
  ): Promise<UnifiedOrder[]> {
    const day: DateRange = { from: date, to: date };
    const session = await this.auth.getSession(account, sessionStore);
    try {
      const statements = await fetchDailyReport(session, day, account.timezone);
      return statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone, date));
    } catch (err) {
      if (err instanceof AuthError && err.authState === 'expired') {
        // Force re-login and retry once
        await sessionStore.remove(account.id);
        const newSession = await this.auth.login(account);
        await sessionStore.set(account.id, newSession);
        const statements = await fetchDailyReport(newSession, day, account.timezone);
        return statements.map(s => normalizeOrder(s, account.id, account.merchantId, account.timezone, date));
      }
      throw err;
    }
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
