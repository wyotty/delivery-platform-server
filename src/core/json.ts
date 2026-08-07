/**
 * JSON.parse that does not silently round integers past 2^53.
 *
 * Grab sends `"orderFlags":4035792627008804869` — an int64 BITFIELD. Plain
 * JSON.parse hands back the nearest double (…805000, drifted by 131) and every
 * JSON.stringify after it writes that wrong number out: the low bits — the flags
 * themselves — are gone, and because the double spacing up there is 512, distinct
 * orders collapse onto the same stored value. Nothing recovers it afterwards; the
 * payload is history the platform will not serve twice.
 *
 * Only an integer literal that cannot survive the round trip is touched. It is
 * wrapped in the one construct JSON.stringify re-emits character for character
 * (JSON.rawJSON), so the digits reach the database unchanged. The wrapper is an
 * object and not a number on purpose: arithmetic on a value we could not represent
 * would be the same silent lie one step further along. Every other number — and
 * every string, which is where all of Grab's money lives — is returned untouched,
 * so callers that read a normal field see exactly what plain JSON.parse gave them.
 *
 * Both halves of this (a reviver's `context.source`, and JSON.rawJSON) are Node 21+
 * and have no TypeScript lib types yet, hence the two casts. Without them the parse
 * below degrades to plain JSON.parse — so this module refuses to load at all on such
 * a runtime, see the probe at the bottom.
 */

/** The reviver's third argument. `source` is present for primitives only. */
interface ReviverContext {
  source?: string;
}

type SourceReviver = (this: unknown, key: string, value: unknown, context: ReviverContext) => unknown;

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;
const parseWithSource = JSON.parse as unknown as (text: string, reviver: SourceReviver) => unknown;

export function parseJsonLossless(text: string): unknown {
  if (!rawJSON) return JSON.parse(text) as unknown;
  return parseWithSource(text, (_key, value, context) => {
    // `String(value)` is the shortest literal that re-parses to the same double, so
    // it differing from the source is precisely "re-serializing this loses digits".
    // Guarding on the safe range as well keeps the wrapper off ordinary numbers:
    // a plain 1e2 or 1.0 also fails that comparison, but its VALUE round-trips, and
    // turning it into an object would break every consumer that reads it.
    if (
      typeof value === 'number'
      && Number.isInteger(value)
      && !Number.isSafeInteger(value)
      && typeof context.source === 'string'
      && context.source !== String(value)
    ) {
      return rawJSON(context.source);
    }
    return value;
  });
}

/**
 * Does this runtime actually round-trip an int64? Grab's real `orderFlags`, through
 * this module's own parse and the JSON.stringify that follows it in repo.ts.
 *
 * A probe rather than `typeof JSON.rawJSON === 'function'`, because the fix needs
 * BOTH halves and that tests one: a runtime with rawJSON but no source-text reviver
 * hands `context.source` back undefined, takes the untouched-value branch above, and
 * rounds every literal while the feature-detect still reads true.
 */
export const preservesLargeIntegers = ((): boolean => {
  const text = '{"orderFlags":4035792627008804869}';
  try {
    return JSON.stringify(parseJsonLossless(text)) === text;
  } catch {
    return false;
  }
})();

// Load-bearing, and deliberately at import rather than at a startup call site: this
// module is on every path that reads or writes a raw payload (api.ts, repo.ts,
// api/index.ts), so nothing can route around it and no future entry point can forget
// to check. A flag that only its own unit test consults would leave the degradation
// its docs describe running silently in production — every int64 rounded on the way
// into orders.raw_json and orders.detail_raw_json, on history Grab will not serve a
// second time. Refusing to start is recoverable; a night of quietly wrong digits is
// not. The same stance money.ts takes on an unknown currency exponent.
if (!preservesLargeIntegers) {
  throw new Error(
    'This runtime rounds integers past 2^53 on JSON round-trip: it lacks JSON.rawJSON '
    + 'and/or the source-text reviver (Node 21+). Refusing to run — every Grab payload '
    + 'stored would silently lose its int64 orderFlags, unrecoverably.',
  );
}
