import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonLossless, preservesLargeIntegers } from './json.js';

// Grab's real `orderFlags` off a live response for 001008233253-C8C3AP61CEDHCJ.
const INT64 = '4035792627008804869';
const ROUNDED = '4035792627008805000';

test('this runtime round-trips an int64 — probed, not assumed', () => {
  // The module degrades to plain JSON.parse without JSON.rawJSON AND the source-text
  // reviver, so a Node that lost either would silently take the rounding back — and
  // every test below would still pass by describing that fallback. The flag is a
  // round trip of the real literal rather than a `typeof JSON.rawJSON` feature
  // detect, because half the mechanism present is indistinguishable from all of it.
  assert.equal(preservesLargeIntegers, true);
});

test('the flag is load-bearing: a runtime that would round refuses to load the module', () => {
  // The point of the check is that it stops the service. A flag nothing consults but
  // its own test leaves the silent degradation running in production, writing rounded
  // int64s into orders.raw_json and orders.detail_raw_json on history Grab will not
  // serve a second time — the one failure this module exists to prevent.
  //
  // Run for real, in a child Node with the mechanism removed, because an import-time
  // throw cannot be observed from inside a process that already imported the module.
  const module = fileURLToPath(new URL('./json.ts', import.meta.url));
  const child = () => execFileSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e',
      `delete JSON.rawJSON; await import(${JSON.stringify(module)});`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

  assert.throws(child, (err: Error & { stderr?: string }) => {
    assert.match(err.stderr ?? '', /Refusing to run/);
    assert.match(err.stderr ?? '', /rounds integers past 2\^53/);
    return true;
  }, 'importing json.ts on a rounding runtime must fail, not warn');
});

test('an integer past 2^53 survives parse → stringify with every digit', () => {
  const text = `{"orderFlags":${INT64},"orderID":"x"}`;
  assert.equal(JSON.stringify(parseJsonLossless(text)), text);

  // What it is being defended against, in one line.
  assert.equal(JSON.stringify(JSON.parse(text)), `{"orderFlags":${ROUNDED},"orderID":"x"}`);
});

test('it is a bitfield, so nearby values must stay distinct', () => {
  // Doubles are spaced 512 apart up there: 104 live orders collapsed onto 3 stored
  // values, and 47 separate orders became indistinguishable on this field.
  const a = parseJsonLossless('{"f":4035792627008804869}');
  const b = parseJsonLossless('{"f":4035792627008804870}');
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.parse('4035792627008804869'), JSON.parse('4035792627008804870')); // …unlike this
});

test('ordinary values come back exactly as JSON.parse gives them', () => {
  // Everything a caller reads has to keep behaving like a number/string/bool, or
  // the fix trades a rounding bug for a type bug. Grab's money is all strings.
  const text = '{"n":0,"neg":-17,"max":9007199254740991,"f":1.5,"s":"32.000","b":true,"z":null,"a":[1,2]}';
  const parsed = parseJsonLossless(text) as Record<string, unknown>;
  assert.deepEqual(parsed, JSON.parse(text));
  assert.equal(typeof parsed.max, 'number', 'the largest safe integer is still a number');
  assert.equal(JSON.stringify(parsed), text);
});

test('a large integer that round-trips on its own is left as a number', () => {
  // 1e21 prints back as "1e+21", so it needs no rescuing and must not be wrapped.
  const parsed = parseJsonLossless('{"v":1e+21}') as { v: unknown };
  assert.equal(typeof parsed.v, 'number');
});

test('malformed JSON still throws rather than returning something', () => {
  assert.throws(() => parseJsonLossless('<!doctype html>'), SyntaxError);
  assert.throws(() => parseJsonLossless(''), SyntaxError);
});
