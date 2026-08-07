import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from '../core/types.js';
import { RETRY_DELAYS_MS, trailingRange, withRetry } from './index.js';

// 2026-07-25 18:00 UTC = 2026-07-26 01:00 in Asia/Ho_Chi_Minh (UTC+7)
const now = new Date('2026-07-25T18:00:00Z');

test('trailingRange uses the merchant timezone, not UTC', () => {
  assert.deepEqual(trailingRange('Asia/Ho_Chi_Minh', 2, now), { from: '2026-07-24', to: '2026-07-26' });
  assert.deepEqual(trailingRange('UTC', 2, now), { from: '2026-07-23', to: '2026-07-25' });
});

test('trailingRange with 0 trailing days is a single day', () => {
  assert.deepEqual(trailingRange('UTC', 0, now), { from: '2026-07-25', to: '2026-07-25' });
});

test('withRetry retries transient errors with the given backoff, then succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET');
      return 'ok';
    },
    [10, 20],
    async ms => { sleeps.push(ms); },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test('withRetry gives up after exhausting delays', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('still down'); }, [10], async () => {}),
    /still down/,
  );
  assert.equal(calls, 2); // initial attempt + one retry
});

test('the default in-run backoff cannot outlive a tick', async () => {
  // The old default was [60_000, 300_000]: six minutes of sleeping inside one run. At a
  // 3-minute cadence that holds the overlap guard through two ticks, each of which logs
  // 'Previous scheduled run still in progress' and is lost — so the backoff did not buy
  // an extra attempt, it cost two. THE NEXT TICK IS THE RETRY now; all this has to cover
  // is a single blip.
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; throw new Error('ECONNRESET'); },
      undefined, // the default is the thing under test
      async ms => { sleeps.push(ms); },
    ),
    /ECONNRESET/,
  );

  const total = sleeps.reduce((a, b) => a + b, 0);
  assert.ok(total < 180_000, `a run must not sleep past its own tick, slept ${total}ms`);
  assert.ok(total <= 30_000, `and should be well short of it, slept ${total}ms`);
  assert.ok(calls >= 2, 'a genuinely transient blip still gets a second chance');
  assert.deepEqual(sleeps, RETRY_DELAYS_MS);
});

test('withRetry never retries AuthError — no silent login hammering', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => { calls++; throw new AuthError('needs_human', 'login broke'); },
      [10, 20],
      async ms => { sleeps.push(ms); },
    ),
    AuthError,
  );
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});
