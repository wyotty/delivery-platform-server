import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The dashboard is one HTML file with an inline script — there is nothing to import.
// Rather than assert on its text (which pins wording, not behaviour), each renderer
// under test is lifted out by name and called for real, in both of the states the
// database can actually be in.
const html = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');

/** One top-level function from the inline script, by brace matching from its opening `{`. */
function source(name: string): string {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `dashboard.html no longer defines ${name}()`);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

interface OrderView { rejectedDetailRawJson: unknown; itemsSuspect: string | null }

const refusedHtml = new Function('rawBox', `${source('refusedHtml')}\nreturn refusedHtml;`)(
  (label: string) => `<details>${label}</details>`,
) as (o: OrderView) => string;

const REFUSED = { order: { orderID: 'x' } };

test('no refused payload renders no banner at all', () => {
  assert.equal(refusedHtml({ rejectedDetailRawJson: null, itemsSuspect: null }), '');
});

test('a refused re-fetch over VERIFIED lines says the stored lines passed the checks', () => {
  const out = refusedHtml({ rejectedDetailRawJson: REFUSED, itemsSuspect: null });
  assert.match(out, /was refused/);
  assert.match(out, /passed those checks/);
  assert.match(out, /repeats every night/);
  assert.match(out, /Refused order detail payload/, 'and the payload itself is still shown');
});

test('a refused re-fetch over SUSPECT lines never calls them verified', () => {
  // schema.ts documents this state and it is reachable: a payload that failed its own
  // completeness checks IS stored when the order has no lines yet (partial data beats
  // none), flagged in items_suspect — and the refusal gate then freezes the order with
  // exactly those lines. The banner used to assert unconditionally that the stored
  // lines were "the earlier, verified ones", printed directly under the warning saying
  // those same lines failed. An operator reconciles a short subtotal against that.
  const out = refusedHtml({ rejectedDetailRawJson: REFUSED, itemsSuspect: 'itemInfo.count 5 != 3 units' });

  assert.doesNotMatch(out, /verified/i);
  assert.doesNotMatch(out, /passed those checks/);
  assert.match(out, /failed the same\s+checks/);
  // Both halves are still said: the refusal repeats, and the payload is kept.
  assert.match(out, /repeats every night/);
  assert.match(out, /Refused order detail payload/);
});

test('the two states really are different text, not one string with a decoration', () => {
  const verified = refusedHtml({ rejectedDetailRawJson: REFUSED, itemsSuspect: null });
  const suspect = refusedHtml({ rejectedDetailRawJson: REFUSED, itemsSuspect: 'line totals 218000 != 317000' });
  assert.notEqual(verified, suspect);
});
