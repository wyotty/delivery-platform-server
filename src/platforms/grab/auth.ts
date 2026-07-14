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

    const { browser, context, page } = await this.launchBrowser();
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
    return { browser, context, page };
  }
}
