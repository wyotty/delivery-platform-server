/**
 * When is a per-order detail fetch actually worth making?
 *
 * The daily report is one call for a whole business day and carries every order's
 * `updatedAt`. The detail endpoint is one call PER ORDER at ~1 req/sec, and on a
 * settled order it returns the same bytes every time. Re-fetching all of them was
 * affordable once a night (~45s of calls); at a 3-minute tick it is ~980 calls an hour
 * against a live production merchant account, essentially all of them re-downloading
 * something we already have.
 *
 * So: fetch when the platform says the order moved, when the lines we hold describe
 * an older version of it, or when what we stored is known to be doubtful — and
 * otherwise leave it, and every row it owns, alone. Deciding this needs nothing from
 * the platform beyond `updatedAt`, so it lives in core and is a pure function of
 * (what the report just said, what the DB holds).
 */

/**
 * What the database already holds for one order, as far as the skip decision cares.
 * Read for a whole business day in ONE query — see repo.getStoredOrderDetail.
 */
export interface StoredOrderDetail {
  /**
   * orders.updated_at — the platform's own timestamp, rewritten from the daily report
   * on EVERY tick regardless of what the detail phase did. So at decision time this
   * is "what the platform said last tick", which is exactly what makes it the right
   * thing to test for "did it move since we last looked".
   */
  updatedAt: string;
  /**
   * orders.detail_updated_at — the platform timestamp of the payload the STORED lines
   * came from. Only a successful line write moves it. NULL = no lines were ever
   * stored (or they predate the column).
   */
  detailUpdatedAt: string | null;
  /** When the detail phase last ran for this order, whatever came of it. The retry clock. */
  detailAttemptedAt: string | null;
  /** Non-null when the STORED lines came from a payload that failed its own checks. */
  itemsSuspect: string | null;
  /** True when a payload was refused (rejected_detail_raw_json): the lines are frozen. */
  rejected: boolean;
}

/**
 * Why an order's detail is being fetched — or `null` for "it isn't". Carried into the
 * log line, because "we made 3 calls this tick" is only useful with the reason beside it.
 */
export type DetailFetchReason =
  /** No row for it yet. Nothing can be stale because nothing is stored. */
  | 'new'
  /** The platform's updatedAt moved since the last tick: the order genuinely changed. */
  | 'changed'
  /** Our lines are missing or describe an older version, and the platform is quiet. */
  | 'retry-stale'
  /** A newer payload was REFUSED; the stored lines are frozen. Long cooldown. */
  | 'retry-rejected'
  /** The stored lines themselves failed their completeness checks. Long cooldown. */
  | 'retry-suspect'
  /** Every order, no questions asked — the backfill's --force path. */
  | 'forced';

export interface RetryCooldowns {
  /**
   * How long before re-attempting an order whose lines are missing or a version behind
   * while the platform reports no change.
   *
   * Short by design and cheap to be wrong about: this case raises no alert (it is
   * reported as itemsMissing and logged), and for an order that is still live the
   * 'changed' rule fires first anyway — Grab moves updatedAt several times over an
   * order's ~15-50 minute lifetime, so a transient 500 heals on the next transition
   * rather than waiting out this clock. What it really governs is orders whose detail
   * call fails permanently: a statement carrying only a booking code, an id the
   * endpoint 404s. Those are the ones that must not be retried 480 times a day.
   */
  retryMissingAfterMs: number;
  /**
   * How long before re-attempting an order whose stored lines are suspect, or whose
   * newer payload was refused.
   *
   * Long by design. Every one of these retries that fails again re-raises the
   * `itemFailures` alert (fetch-service), and the condition is typically permanent —
   * Grab re-serves the same truncated payload until someone looks. A day is what the
   * nightly run gave, which is the cadence that alert was written for; anything much
   * shorter turns one frozen order into a pager loop.
   */
  retrySuspectAfterMs: number;
}

/**
 * The rule. `stored` is undefined when the day's lookup had no row for this order.
 *
 * Order matters, twice over:
 *
 *  - 'changed' outranks every cooldown. A moved updatedAt is new information from the
 *    platform, and it cannot loop: the report's updatedAt is stored on every tick, so
 *    one change buys exactly one immediate fetch. Everything below it describes an
 *    order the platform says has NOT moved, where the only thing that can be wrong is
 *    on our side and a retry is a guess.
 *  - 'rejected' outranks 'stale', even though a rejected order is also stale. It is
 *    the case that alerts a human every time it repeats, so it must be governed by the
 *    long clock and not the short one.
 */
export function detailFetchReason(
  platformUpdatedAt: string,
  stored: StoredOrderDetail | undefined,
  now: number,
  cooldowns: RetryCooldowns,
): DetailFetchReason | null {
  if (!stored) return 'new';
  if (stored.updatedAt !== platformUpdatedAt) return 'changed';

  const cooled = (afterMs: number) => {
    // Never attempted (including every row written before detail_attempted_at
    // existed) — attempt it once, which sets the clock.
    if (stored.detailAttemptedAt === null) return true;
    const elapsed = now - Date.parse(stored.detailAttemptedAt);
    // NaN when the stored value is unreadable: `NaN < afterMs` is false, so an
    // unparseable timestamp retries rather than freezing the order out of retries
    // forever. A timestamp in the future (a clock stepped backwards) waits instead,
    // which is the direction that costs a live merchant account nothing.
    return !(elapsed < afterMs);
  };

  // A refused payload is the only state that cannot clear itself — the write that
  // would clear it is the one being refused — so it stays retryable, or the order is
  // frozen for good with its alert silenced. On the long clock, because each retry
  // that fails the same way alerts again.
  if (stored.rejected) return cooled(cooldowns.retrySuspectAfterMs) ? 'retry-rejected' : null;
  // No lines, or lines from an older version of this order: a fetch that was aborted,
  // timed out, hit the deadline, or never happened. Cheap to retry, nobody is paged.
  if (stored.detailUpdatedAt !== platformUpdatedAt) {
    return cooled(cooldowns.retryMissingAfterMs) ? 'retry-stale' : null;
  }
  // Lines are current but came from a payload that failed its checks (they were stored
  // because partial data beat nothing at all). A retry can only improve them: a clean
  // payload replaces them and clears the flag, and another suspect one is refused by
  // the gate — which moves this order to 'rejected' above, on the same clock.
  if (stored.itemsSuspect !== null) return cooled(cooldowns.retrySuspectAfterMs) ? 'retry-suspect' : null;

  // Unchanged, lines current, nothing doubted. Leave every stored row exactly as it
  // is — including items_fetched_at, which must keep meaning "last confirmed".
  return null;
}

/**
 * The retry clock for orders that have NO ROW — the one case the rule above cannot
 * govern, because every clock it reads lives in the row.
 *
 * `detail_attempted_at` is stamped by repo.ts over the orders that actually landed.
 * An order rejected by unstorableReason (an unreadable value bound to a NOT NULL
 * column) or by the upsert backstop never gets a row at all, so getStoredOrderDetail
 * never returns it, `stored` is undefined, and the rule above answers 'new' — every
 * tick, forever. Reproduced against the real repo and connector: one such order made
 * a detail call on 480 of 480 simulated ticks with 0 rows ever written, at ~1 s a
 * call, for an order that can never be stored no matter how often it is fetched.
 *
 * So the clock has to live somewhere that survives the row not existing. This is that
 * place: a process-level map, held by the connector, keyed by account + order id.
 *
 * Why in memory rather than a table of its own:
 *   - The value it holds is "when did WE last try", which is exactly what
 *     detail_attempted_at means. A second persisted copy is a second clock that can
 *     disagree with the first, on the same question, for the same order.
 *   - Being wrong is cheap in one direction only, and that is the direction a restart
 *     takes it: an empty map means one extra detail call per unstorable order, once,
 *     and then the cooldown is back. Forgetting is a rounding error; a stale
 *     persisted row that outlives the problem is a silently frozen order.
 *   - It needs no migration and writes nothing for orders we have deliberately
 *     refused to write.
 *
 * Bounded by construction: `prune` drops everything older than the cooldown, which is
 * semantically free (an entry that old is due anyway), so the map holds at most the
 * orders seen within one cooldown window.
 */
export class NoRowRetryLog {
  private readonly lastAttempt = new Map<string, number>();

  /**
   * May this rowless order be fetched now? Claiming BOTH answers and starts the
   * clock — there is no way to ask without paying, which is what stops a caller from
   * checking in one place and forgetting to record in another.
   */
  claim(key: string, now: number, cooldownMs: number): boolean {
    const last = this.lastAttempt.get(key);
    // NaN-safe by the same reasoning as `cooled` above: an unusable stored value
    // retries rather than freezing the order out of retries for the life of the process.
    if (last !== undefined && now - last < cooldownMs) return false;
    this.lastAttempt.set(key, now);
    return true;
  }

  /** Drop entries whose cooldown has already expired — they would be claimed anyway. */
  prune(now: number, cooldownMs: number): void {
    for (const [key, at] of this.lastAttempt) {
      if (now - at >= cooldownMs) this.lastAttempt.delete(key);
    }
  }

  /** Entries currently held. Only the memory bound cares. */
  get size(): number {
    return this.lastAttempt.size;
  }
}
