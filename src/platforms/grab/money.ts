// Grab reports money as locale-formatted display strings. In VND (exponent 0) the
// '.' is a THOUSANDS separator, so parseFloat('5.000') returns 5 — a silent 1000x
// error, in the same direction, on every priced modifier, forever. The order-detail
// endpoint gives modifier prices as display strings ONLY (the menu endpoint does
// carry integers, but catalog prices drift and must never be joined into history),
// so this parser is the whole defence.
import { GrabStatement } from './api.js';

/**
 * ISO 4217 minor-unit exponents for the currencies Grab operates in, consulted
 * only when a statement omits its own exponent — which has never been observed.
 * Deliberately no catch-all default: assuming 2 for a zero-decimal currency is a
 * 100x error on every row, and one loudly failed order beats a silently wrong
 * ledger nobody can spot after the fact.
 */
const ISO_EXPONENTS: Record<string, number> = {
  VND: 0, JPY: 0, KRW: 0,
  SGD: 2, MYR: 2, THB: 2, PHP: 2, IDR: 2, KHR: 2, MMK: 2,
};

/** Minor-unit exponent for a statement's currency. Never guessed from the symbol. */
export function grabCurrencyExponent(statement: GrabStatement): number {
  const raw = statement.currency?.exponent;
  // Check the string before trusting the number: the real value is "0", and
  // Number('') is also 0 — an empty field would masquerade as zero-decimal.
  const declared = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (Number.isInteger(declared) && declared >= 0 && declared <= 4) return declared;

  const code = statement.currency?.code;
  const known = code ? ISO_EXPONENTS[code] : undefined;
  if (known !== undefined) return known;

  throw new Error(`Cannot determine minor-unit exponent for currency ${code || '(missing)'}`);
}

// A grouped integer: 1-3 digits, then groups of exactly 3. '0.0000' (taxRate) and
// '1.23' both fail this on purpose — a rate and a 2dp decimal are not VND money.
const GROUPED = /^\d{1,3}(?:[.,]\d{3})*$/;
const PLAIN = /^\d+$/;

/**
 * Parse one of Grab's display strings into minor units.
 *
 * Returns null only for the two sentinels Grab uses for "none": '' (seen on
 * merchantChargeDisplay) and '-' (seen on promotionDisplay). Anything else either
 * parses exactly or throws — a string this does not recognise (a currency symbol,
 * a rate like taxRate's '0.0000') means the format changed, and a wrong number is
 * far more expensive than a failed order.
 */
export function parseGrabAmount(display: string | null | undefined, exponent: number): number | null {
  if (display == null) return null;
  const s = display.replace(/\s/gu, ''); // \s covers U+00A0 and friends
  if (s === '' || s === '-') return null;
  if (!/^-?[\d.,]+$/.test(s)) throw new Error(`Unparseable Grab amount: ${JSON.stringify(display)}`);

  const negative = s.startsWith('-');
  const d = negative ? s.slice(1) : s;
  let minor: number;

  if (exponent === 0) {
    // This currency has no decimal separator, so every '.' and ',' is grouping.
    if (!GROUPED.test(d) && !PLAIN.test(d)) throw new Error(`Unparseable Grab amount: ${JSON.stringify(display)}`);
    minor = Number(d.replace(/[.,]/g, ''));
  } else {
    const i = Math.max(d.lastIndexOf('.'), d.lastIndexOf(','));
    if (i === -1) {
      minor = Number(d) * 10 ** exponent;
    } else {
      const frac = d.slice(i + 1);
      const int = d.slice(0, i);
      if (frac.length === exponent) {
        if (!GROUPED.test(int) && !PLAIN.test(int)) throw new Error(`Unparseable Grab amount: ${JSON.stringify(display)}`);
        minor = Number(int.replace(/[.,]/g, '')) * 10 ** exponent + Number(frac);
      } else if (frac.length === 3) {
        // Three digits after the last separator: grouping, not a decimal point.
        if (!GROUPED.test(d)) throw new Error(`Unparseable Grab amount: ${JSON.stringify(display)}`);
        minor = Number(d.replace(/[.,]/g, '')) * 10 ** exponent;
      } else {
        // Neither exponent-length nor a group of 3 — refuse rather than pick one.
        throw new Error(`Ambiguous Grab amount: ${JSON.stringify(display)} (exponent ${exponent})`);
      }
    }
  }

  if (!Number.isSafeInteger(minor)) throw new Error(`Grab amount out of safe integer range: ${JSON.stringify(display)}`);
  return negative ? -minor : minor;
}
