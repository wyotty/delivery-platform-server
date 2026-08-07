/**
 * How many headless logins an account may spend — measured in WALL-CLOCK TIME across
 * the life of the process, not per run.
 *
 * A per-run cap bounded nothing once the scheduler started ticking every 3 minutes.
 * Measured with a counting authenticator against the real connector: cookies that
 * permanently 401 cost one full Playwright login per tick (480/day at a 3-minute cadence), and a
 * login that fails with a PLAIN Playwright error — a changed login page, a CAPTCHA, a
 * `page.fill` timeout, none of which auth.ts raises AuthError for — cost three per
 * tick (1,440/day), because the scheduler's own retry ran the whole account again.
 * Both were stable over five consecutive ticks. That is the account lockout the
 * per-run budget was written to prevent, arriving through the tick rate instead.
 *
 * Gating on the stored session state does not work either: setSessionState is only
 * reached on the AuthError branch, so the plain-Playwright case left the state
 * untouched and every tick sailed through the scheduler's `needs_human` check. So
 * this gate deliberately depends on NOTHING but its own memory of what it allowed.
 *
 * Two independent bounds, because they fail in different directions:
 *
 *   - A rolling-window CEILING on attempts. Counted when the attempt is made, not
 *     when it finishes, so a login that hangs or throws still spends its slot. This
 *     is what bounds the case where every login SUCCEEDS and the session it produces
 *     is rejected immediately — nothing ever "fails", so no failure counter moves.
 *   - Exponential BACKOFF on consecutive failures, so a login that is broken right
 *     now goes quiet within one step instead of being retried every tick.
 *
 * Recovery is automatic and cannot be forgotten: the backoff is a timestamp that
 * expires, the ceiling is a window that slides, and one successful login clears the
 * failure streak. Nothing here can put an account into a state a human has to undo.
 *
 * Process-level and in-memory on purpose. A restart is the one event that should get
 * a fresh attempt — a redeploy is usually the fix — and it costs exactly one login.
 */

/** Attempts allowed per account per `windowMs`, however they turn out. */
export const LOGIN_MAX_PER_WINDOW = 4;
export const LOGIN_WINDOW_MS = 3_600_000;
/**
 * Cooldown after the 1st, 2nd, 3rd+ consecutive failure; the last entry repeats.
 * Ends at one attempt an hour, which is the steady state for a login that is simply
 * broken: visible in the logs, still recovering on its own the moment it is fixed,
 * and ~24 logins a day instead of 1,440.
 */
export const LOGIN_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000];

export interface LoginGateOptions {
  maxPerWindow?: number;
  windowMs?: number;
  backoffMs?: number[];
  /** Injectable clock — the tests must not sleep for an hour to prove an hour. */
  now?: () => number;
}

interface AccountState {
  /** Timestamps of attempts still inside the window. */
  attempts: number[];
  consecutiveFailures: number;
  /** 0 = not backing off. */
  blockedUntil: number;
}

export class LoginGate {
  private readonly state = new Map<string, AccountState>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly backoffMs: number[];
  private readonly now: () => number;

  constructor(opts: LoginGateOptions = {}) {
    this.maxPerWindow = opts.maxPerWindow ?? LOGIN_MAX_PER_WINDOW;
    this.windowMs = opts.windowMs ?? LOGIN_WINDOW_MS;
    this.backoffMs = opts.backoffMs ?? LOGIN_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Claim one login for this account.
   *
   * `null` means go ahead — AND the attempt is already recorded, so a login that
   * never returns has still been paid for. A string is the reason it was refused,
   * written to be read in an alert.
   */
  take(accountId: string): string | null {
    const now = this.now();
    const s = this.get(accountId);
    s.attempts = s.attempts.filter(t => now - t < this.windowMs);

    // Both reasons name an ABSOLUTE instant rather than a countdown, and that is not
    // cosmetic: this string ends up in an AuthError message, which is what the alert
    // throttle keys on. A "~57 min" that ticks down to "~54 min" is a different string
    // every three minutes, so a muted condition would un-mute itself on every tick and
    // the flood would come back through the other door. These two values change only
    // when the gate's state genuinely changes — which is exactly when it is worth
    // saying again.
    if (s.blockedUntil > now) {
      return `backing off after ${s.consecutiveFailures} consecutive login failure(s) — next attempt after ${new Date(s.blockedUntil).toISOString()}`;
    }
    if (s.attempts.length >= this.maxPerWindow) {
      const freeAt = new Date(s.attempts[0] + this.windowMs).toISOString();
      return `login rate limit: ${s.attempts.length} attempts within ${Math.round(this.windowMs / 60_000)} min — next attempt after ${freeAt}`;
    }

    s.attempts.push(now);
    return null;
  }

  /**
   * The login produced a session that actually worked. Clears the streak, so an
   * account that recovers is back to full speed on the next tick with no human step.
   * The window ceiling is deliberately NOT cleared: a session that has to be minted
   * four times an hour is still a problem, whether or not each mint "worked".
   */
  succeeded(accountId: string): void {
    const s = this.get(accountId);
    s.consecutiveFailures = 0;
    s.blockedUntil = 0;
  }

  /**
   * The login threw, or the session it produced was rejected on first use — the same
   * thing from the account's point of view, and the second is the shape the
   * permanently-401 case takes.
   */
  failed(accountId: string): void {
    const s = this.get(accountId);
    s.consecutiveFailures++;
    const step = this.backoffMs[Math.min(s.consecutiveFailures - 1, this.backoffMs.length - 1)];
    s.blockedUntil = this.now() + step;
  }

  /** For logging and tests: what the gate currently believes about an account. */
  snapshot(accountId: string): { attemptsInWindow: number; consecutiveFailures: number; blockedForMs: number } {
    const now = this.now();
    const s = this.get(accountId);
    return {
      attemptsInWindow: s.attempts.filter(t => now - t < this.windowMs).length,
      consecutiveFailures: s.consecutiveFailures,
      blockedForMs: Math.max(0, s.blockedUntil - now),
    };
  }

  private get(accountId: string): AccountState {
    let s = this.state.get(accountId);
    if (!s) {
      s = { attempts: [], consecutiveFailures: 0, blockedUntil: 0 };
      this.state.set(accountId, s);
    }
    return s;
  }
}
