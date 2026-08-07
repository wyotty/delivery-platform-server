import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoRowRetryLog, RetryCooldowns, StoredOrderDetail, detailFetchReason } from './detail-refresh.js';

const NOW = Date.parse('2026-08-07T12:00:00Z');
const UPDATED = '2026-08-07T11:00:00Z';
const EARLIER = '2026-08-07T10:00:00Z';

const cooldowns: RetryCooldowns = { retryMissingAfterMs: 900_000, retrySuspectAfterMs: 86_400_000 };
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** The ordinary row: unchanged, lines current, nothing doubted. */
const stored = (over: Partial<StoredOrderDetail> = {}): StoredOrderDetail => ({
  updatedAt: UPDATED,
  detailUpdatedAt: UPDATED,
  detailAttemptedAt: ago(60_000),
  itemsSuspect: null,
  rejected: false,
  ...over,
});

const decide = (s: StoredOrderDetail | undefined, now = NOW) => detailFetchReason(UPDATED, s, now, cooldowns);

test('an order we have never stored is fetched', () => {
  assert.equal(decide(undefined), 'new');
});

test('an unchanged order with current lines is not fetched', () => {
  // The whole point: 44 orders a tick, 480 ticks a day, and this is the answer for
  // almost every one of them.
  assert.equal(decide(stored()), null);
});

test("a moved updatedAt is fetched at once, whatever the retry clocks say", () => {
  // Even one second after the last attempt, and even for an order flagged suspect:
  // the platform reporting a new timestamp is information, not a guess.
  assert.equal(decide(stored({ updatedAt: EARLIER, detailAttemptedAt: ago(1_000) })), 'changed');
  assert.equal(
    decide(stored({ updatedAt: EARLIER, detailAttemptedAt: ago(1_000), itemsSuspect: 'short' })),
    'changed',
  );
});

test('a detail fetch that never landed keeps asking until one does', () => {
  // THE failure this design turns on. Phase 1 of the upsert writes the report's
  // updated_at for every order on every tick — including orders whose detail call was
  // aborted, timed out, or hit the deadline. Compare the report against orders.updated_at
  // and that flag is consumed by the run that failed to act on it, leaving the order
  // one version behind forever with nothing anywhere saying so. Comparing against
  // detail_updated_at (what the STORED LINES describe) is what makes it self-healing.
  const aborted = stored({ updatedAt: UPDATED, detailUpdatedAt: EARLIER, detailAttemptedAt: ago(20 * 60_000) });
  assert.equal(decide(aborted), 'retry-stale');

  // Never fetched at all is the same state with a NULL in it.
  assert.equal(decide(stored({ detailUpdatedAt: null, detailAttemptedAt: ago(20 * 60_000) })), 'retry-stale');

  // …but not on the very next tick. That is the difference between retrying and
  // hammering: 480 attempts a day at an order whose detail endpoint is broken.
  assert.equal(decide(stored({ detailUpdatedAt: EARLIER, detailAttemptedAt: ago(60_000) })), null);
});

test('an order never attempted is attempted once, which starts its clock', () => {
  // Also the migration path: every row written before detail_attempted_at existed has
  // NULL here, and gets exactly one catch-up fetch rather than none or endless ones.
  assert.equal(decide(stored({ detailUpdatedAt: null, detailAttemptedAt: null })), 'retry-stale');
});

test('a permanently suspect order is not re-fetched every tick forever', () => {
  // Grab re-serves the same truncated payload until a human looks. Simulate a day of
  // 3-minute ticks against an order stuck in that state, advancing the attempt clock
  // exactly as a real attempt would.
  let row = stored({ itemsSuspect: 'items sum to 254.000, subtotal says 317.000', detailAttemptedAt: null });
  let fetches = 0;
  for (let tick = 0; tick < 480; tick++) {
    const now = NOW + tick * 3 * 60_000;
    if (detailFetchReason(UPDATED, row, now, cooldowns) !== null) {
      fetches++;
      row = { ...row, detailAttemptedAt: new Date(now).toISOString() };
    }
  }
  // One a day is the cadence the nightly run had — and the cadence the itemFailures
  // alert was written for. 480 would be a pager loop, not a retry.
  assert.equal(fetches, 1, '480 ticks, one attempt');
});

test('an order whose detail is permanently missing retries on the short clock, still bounded', () => {
  // No alert fires for this one and the fix is cheap, so it is allowed to try more
  // often — but it must still be a fraction of the tick rate.
  let row = stored({ detailUpdatedAt: null, detailAttemptedAt: null });
  let fetches = 0;
  for (let tick = 0; tick < 480; tick++) {
    const now = NOW + tick * 3 * 60_000;
    if (detailFetchReason(UPDATED, row, now, cooldowns) !== null) {
      fetches++;
      row = { ...row, detailAttemptedAt: new Date(now).toISOString() };
    }
  }
  assert.equal(fetches, 96, 'one every 15 minutes, not one every tick');
});

test('a refused payload stays retryable, but on the suspect clock and not the stale one', () => {
  // A rejected order is stale too — its lines describe an older version by definition,
  // since a newer payload arrived and was refused. It must not therefore fall into the
  // short clock: every retry that fails the same way raises the itemFailures alert.
  const frozen = stored({ rejected: true, detailUpdatedAt: EARLIER, detailAttemptedAt: ago(20 * 60_000) });
  assert.equal(decide(frozen), null, 'the 15-minute clock must not govern an alerting retry');
  assert.equal(decide({ ...frozen, detailAttemptedAt: ago(25 * 3600_000) }), 'retry-rejected');
});

test('stored-but-suspect lines are retried, because a retry can only improve them', () => {
  const suspect = stored({ itemsSuspect: 'itemInfo.count says 6, payload carries 3' });
  assert.equal(decide({ ...suspect, detailAttemptedAt: ago(3600_000) }), null);
  assert.equal(decide({ ...suspect, detailAttemptedAt: ago(25 * 3600_000) }), 'retry-suspect');
});

test('an unreadable attempt timestamp retries rather than freezing the order out', () => {
  // A NaN comparison is false either way; the direction has to be chosen deliberately.
  // Retrying costs one call, the other way costs an order that is never repaired again.
  assert.equal(decide(stored({ detailUpdatedAt: null, detailAttemptedAt: 'garbage' })), 'retry-stale');
});

test('a clock stepped backwards waits instead of retrying', () => {
  // The opposite direction from NaN, on purpose: a future timestamp is a machine
  // problem, and spending it on requests to a live merchant account is not the answer.
  assert.equal(decide(stored({ detailUpdatedAt: null, detailAttemptedAt: ago(-3600_000) })), null);
});

// ===== the rowless clock =====
//
// Every clock above lives in the order's row. These are for the order that has none.

test('an order with no row is fetched once, not once per tick', () => {
  // The measured failure: an order the writer refuses gets no row, so the day's lookup
  // never returns it, so the rule above says 'new' — 480 times a day, 480 detail calls,
  // 0 rows ever written. The rowless clock is what turns that into the same 15-minute
  // retry any other missing detail gets.
  const log = new NoRowRetryLog();
  let calls = 0;
  let hammered = 0;
  for (let tick = 0; tick < 480; tick++) {
    const now = NOW + tick * 3 * 60_000;
    hammered++; // what it cost before: 'new' is unconditional when there is no row
    if (log.claim('acct-1/BROKEN-ORDER', now, 900_000)) calls++;
  }
  assert.equal(hammered, 480, 'the condition really does recur on every single tick');
  assert.equal(calls, 96, 'one every 15 minutes — the same clock a stored-but-missing detail gets');
});

test('the rowless clock is a cooldown, not a blacklist', () => {
  // A write that fails once (a lock, a disk, a bug just deployed) must heal by itself.
  const log = new NoRowRetryLog();
  assert.equal(log.claim('acct-1/A', NOW, 900_000), true);
  assert.equal(log.claim('acct-1/A', NOW + 899_999, 900_000), false);
  assert.equal(log.claim('acct-1/A', NOW + 900_000, 900_000), true, 'it always comes back');
});

test('a restart degrades to one extra attempt, never to hammering again', () => {
  // The whole reason this is allowed to be in memory: losing it costs one call.
  const before = new NoRowRetryLog();
  assert.equal(before.claim('acct-1/A', NOW, 900_000), true);
  assert.equal(before.claim('acct-1/A', NOW + 60_000, 900_000), false);

  const afterRestart = new NoRowRetryLog(); // a fresh process, an empty map
  assert.equal(afterRestart.claim('acct-1/A', NOW + 60_000, 900_000), true, 'one catch-up attempt');
  assert.equal(afterRestart.claim('acct-1/A', NOW + 120_000, 900_000), false, 'and then the bound is back');
});

test('two accounts on one platform are not each other', () => {
  const log = new NoRowRetryLog();
  assert.equal(log.claim('acct-1/A', NOW, 900_000), true);
  assert.equal(log.claim('acct-2/A', NOW, 900_000), true);
});

test('the map holds at most one cooldown window of orders', () => {
  // Bounded memory in a process that runs for months: pruning an entry whose cooldown
  // has expired changes no decision, because that entry would have been claimed anyway.
  const log = new NoRowRetryLog();
  for (let i = 0; i < 1000; i++) log.claim(`acct-1/ORDER-${i}`, NOW + i * 1_000, 900_000);
  assert.equal(log.size, 1000);

  log.prune(NOW + 1000 * 1_000, 900_000);
  assert.ok(log.size < 1000, 'expired entries are dropped');
  // …and dropping them is invisible: an expired entry is claimable either way.
  assert.equal(log.claim('acct-1/ORDER-0', NOW + 1000 * 1_000, 900_000), true);
});

test('a backlog too big for one tick drains instead of restarting every tick', () => {
  // The first tick after a deploy or a migration legitimately re-verifies the whole
  // window, and that can exceed one tick's detail budget: 3 days at 100 orders is 300
  // calls at ~1.05 s each, against a 120 s deadline (~114 calls). What must not happen
  // is the backlog restarting from the top every tick and never finishing.
  //
  // The orders a tick could not reach are stamped detail_attempted_at all the same
  // (repo.ts marks every order the run planned, including the ones the deadline cut
  // off), so they come back on the 15-minute clock rather than immediately — which is
  // what keeps every OTHER tick in that window cheap.
  const CALLS_PER_TICK = 114;
  const rows = Array.from({ length: 300 }, () => stored({ detailUpdatedAt: null, detailAttemptedAt: null }));

  let ticksToDrain = -1;
  let busiestTick = 0;
  for (let tick = 0; tick < 480 && ticksToDrain < 0; tick++) {
    const now = NOW + tick * 3 * 60_000;
    const due = rows.filter(r => detailFetchReason(UPDATED, r, now, cooldowns) !== null);
    let budget = CALLS_PER_TICK;
    let calls = 0;
    for (const row of due) {
      row.detailAttemptedAt = new Date(now).toISOString(); // stamped either way
      if (budget-- > 0) { row.detailUpdatedAt = UPDATED; calls++; } // fetched
    }
    busiestTick = Math.max(busiestTick, calls);
    if (rows.every(r => r.detailUpdatedAt === UPDATED)) ticksToDrain = tick + 1;
  }

  assert.ok(ticksToDrain > 0, 'the backlog must actually finish');
  assert.ok(ticksToDrain <= 15, `and within the hour: took ${ticksToDrain} ticks (${ticksToDrain * 3} min)`);
  assert.ok(busiestTick <= CALLS_PER_TICK, 'no tick may exceed what its deadline allows');
});
