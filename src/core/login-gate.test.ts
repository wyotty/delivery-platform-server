import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoginGate } from './login-gate.js';

const HOUR = 3_600_000;
const MIN = 60_000;

/** A clock the test moves by hand — an hour of backoff must cost no wall time. */
const clockAt = (start = Date.parse('2026-08-07T00:00:00Z')) => {
  const c = { t: start, advance(ms: number) { c.t += ms; } };
  return c;
};

test('a login that keeps failing is attempted a handful of times a day, not 480', () => {
  // The measured shape: at a 3-minute cadence a broken login cost one Chromium launch
  // per tick, and three when the scheduler's own retry ran the account again — 480 to
  // 1,440 headless logins a day against a live merchant account.
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  let logins = 0;
  for (let tick = 0; tick < 480; tick++) { // a full day at 3-minute ticks
    if (gate.take('acct') === null) {
      logins++;
      gate.failed('acct'); // it is broken, and stays broken all day
    }
    clock.advance(3 * MIN);
  }

  // 5 min, then 15, then one an hour: ~24 attempts in a day, every one of them logged,
  // and the account never locked out for being hammered.
  assert.ok(logins <= 30, `a day of a broken login must stay small, got ${logins}`);
  assert.ok(logins >= 10, `…but it must keep trying, got ${logins}`);
});

test('a login that succeeds every time but never produces a usable session is still capped', () => {
  // The other measured shape, and the one no failure counter catches: cookies that
  // permanently 401. login() works, so nothing "fails" — only a time-based ceiling on
  // ATTEMPTS bounds it.
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  let logins = 0;
  for (let tick = 0; tick < 480; tick++) {
    if (gate.take('acct') === null) {
      logins++;
      gate.succeeded('acct'); // the login itself is fine, every time
    }
    clock.advance(3 * MIN);
  }

  assert.equal(logins, 4 * 24, 'the rolling ceiling holds at 4 an hour with no failure ever recorded');
});

test('the ceiling is a sliding window, not a bucket that never refills', () => {
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  for (let i = 0; i < 4; i++) {
    assert.equal(gate.take('acct'), null);
    gate.succeeded('acct');
  }
  assert.match(gate.take('acct') ?? '', /rate limit/, 'the fifth attempt in the hour is refused');

  clock.advance(HOUR + 1);
  assert.equal(gate.take('acct'), null, 'and the hour passing is all it takes to be allowed again');
});

test('backoff escalates with consecutive failures and one success clears it', () => {
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  assert.equal(gate.take('acct'), null);
  gate.failed('acct');
  clock.advance(4 * MIN);
  assert.match(gate.take('acct') ?? '', /backing off after 1 consecutive/);

  clock.advance(2 * MIN); // 6 min in: the 5-minute step has expired
  assert.equal(gate.take('acct'), null);
  gate.failed('acct');
  clock.advance(14 * MIN);
  assert.match(gate.take('acct') ?? '', /backing off after 2 consecutive/, 'the second step is longer');

  clock.advance(2 * MIN);
  assert.equal(gate.take('acct'), null);
  gate.succeeded('acct');
  assert.equal(gate.snapshot('acct').consecutiveFailures, 0);
  assert.equal(gate.snapshot('acct').blockedForMs, 0, 'recovery needs no human and no restart');
});

test('the refusal reason is stable while the state is, so a muted alert stays muted', () => {
  // The reason ends up in an AuthError message, and that message is what the alert
  // throttle keys on. A countdown ('~57 min') is a different string every tick, which
  // would un-mute the condition on every tick and put the alert flood back.
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  assert.equal(gate.take('acct'), null);
  gate.failed('acct');
  const first = gate.take('acct');
  clock.advance(60_000);
  assert.equal(gate.take('acct'), first, 'same state, same words');

  clock.advance(5 * MIN);
  assert.equal(gate.take('acct'), null);
  gate.failed('acct');
  assert.notEqual(gate.take('acct'), first, 'a new failure is a new thing to say');
});

test('accounts are gated independently', () => {
  const clock = clockAt();
  const gate = new LoginGate({ now: () => clock.t });

  assert.equal(gate.take('a'), null);
  gate.failed('a');
  assert.ok(gate.take('a'), 'a is backing off');
  assert.equal(gate.take('b'), null, 'b has done nothing wrong');
});

test('an attempt is spent when it is made, not when it returns', () => {
  // A login that hangs until the process is killed must still have cost its slot;
  // otherwise a stuck Playwright is an uncounted login every tick.
  const clock = clockAt();
  const gate = new LoginGate({ maxPerWindow: 1, now: () => clock.t });

  assert.equal(gate.take('acct'), null); // …and now imagine it never comes back
  assert.match(gate.take('acct') ?? '', /rate limit/);
  assert.equal(gate.snapshot('acct').attemptsInWindow, 1);
});
