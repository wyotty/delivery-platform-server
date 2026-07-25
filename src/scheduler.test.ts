import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthError } from './core/types.js';
import { trailingRange, withRetry } from './scheduler.js';

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
