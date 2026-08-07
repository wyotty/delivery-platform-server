import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, ThrottledNotifier } from './index.js';

class Collecting implements Notifier {
  readonly enabled = true;
  sent: string[] = [];
  async alert(message: string) { this.sent.push(message); }
}

const SIX_HOURS = 6 * 3_600_000;
const clockAt = (start = Date.parse('2026-08-07T00:00:00Z')) => ({ t: start });

test('the same condition on every tick is one message, not 480', () => {
  // Measured before the throttle existed: one unstorable order raised one Telegram
  // message per run, 480 a day, every one of them the same sentence. An alert that
  // arrives 480 times is what makes the next real one invisible.
  const clock = clockAt();
  const inner = new Collecting();
  const notifier = new ThrottledNotifier(inner, undefined, SIX_HOURS, () => clock.t);

  return (async () => {
    for (let tick = 0; tick < 480; tick++) {
      await notifier.alert(`🔴 could not store 1 of 12 orders\nRange: 2026-08-05..2026-08-07`, 'orderFailures:acct-1:X=bad');
      clock.t += 3 * 60_000; // a full day of 3-minute ticks
    }
    // Four 6-hour windows in a day: the first message, then a heartbeat at each window.
    assert.equal(inner.sent.length, 4);
  })();
});

test('a NEW distinct failure is never delayed by a muted one', async () => {
  const clock = clockAt();
  const inner = new Collecting();
  const notifier = new ThrottledNotifier(inner, undefined, SIX_HOURS, () => clock.t);

  await notifier.alert('order A is unstorable', 'orderFailures:acct-1:A=bad');
  await notifier.alert('order A is unstorable', 'orderFailures:acct-1:A=bad');
  assert.equal(inner.sent.length, 1, 'the repeat is muted');

  // A second order breaks one second later. Different condition, different key.
  clock.t += 1_000;
  await notifier.alert('orders A and B are unstorable', 'orderFailures:acct-1:A=bad|B=bad');
  assert.equal(inner.sent.length, 2, 'and it goes out at once');

  // …as does the same order failing a NEW way.
  await notifier.alert('order A is unstorable', 'orderFailures:acct-1:A=worse');
  assert.equal(inner.sent.length, 3);
});

test('the message that ends a mute says how much was muted', async () => {
  // The heartbeat. A condition that outlives its own alert must not look like a
  // condition that stopped.
  const clock = clockAt();
  const inner = new Collecting();
  const notifier = new ThrottledNotifier(inner, undefined, SIX_HOURS, () => clock.t);

  await notifier.alert('auth expired', 'auth:acct-1');
  for (let i = 0; i < 119; i++) {
    clock.t += 3 * 60_000;
    await notifier.alert('auth expired', 'auth:acct-1');
  }
  assert.equal(inner.sent.length, 1);

  clock.t += 3 * 60_000; // past the 6-hour window
  await notifier.alert('auth expired', 'auth:acct-1');
  assert.equal(inner.sent.length, 2);
  assert.match(inner.sent[1], /still failing: 119 more occurrence/);
});

test('a condition that stops and starts again is reported again', async () => {
  // Muting is a property of the window, not a verdict about the problem: nothing here
  // may leave a real failure permanently unreportable.
  const clock = clockAt();
  const inner = new Collecting();
  const notifier = new ThrottledNotifier(inner, undefined, SIX_HOURS, () => clock.t);

  await notifier.alert('auth expired', 'auth:acct-1');
  clock.t += 2 * SIX_HOURS + 1; // fixed, quiet for half a day, then broken again
  await notifier.alert('auth expired', 'auth:acct-1');

  assert.equal(inner.sent.length, 2);
  assert.doesNotMatch(inner.sent[1], /still failing/, 'nothing was suppressed while it was healthy');
});

test('an unkeyed alert falls back to its own text', async () => {
  const clock = clockAt();
  const inner = new Collecting();
  const notifier = new ThrottledNotifier(inner, undefined, SIX_HOURS, () => clock.t);

  await notifier.alert('identical words');
  await notifier.alert('identical words');
  await notifier.alert('different words');

  assert.deepEqual(inner.sent, ['identical words', 'different words']);
});

test('memory does not grow with the number of ticks', async () => {
  // One entry per distinct condition, and only while it is still worth remembering.
  const clock = clockAt();
  const notifier = new ThrottledNotifier(new Collecting(), undefined, SIX_HOURS, () => clock.t);
  const size = () => (notifier as unknown as { sent: Map<string, unknown> }).sent.size;

  for (let i = 0; i < 500; i++) {
    await notifier.alert(`transient failure ${i}`, `fetchFailed:acct-1:${i}`);
    clock.t += 3 * 60_000;
  }
  assert.ok(size() < 300, `entries outside two windows must be dropped, held ${size()}`);
});
