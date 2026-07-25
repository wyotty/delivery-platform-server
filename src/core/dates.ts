// Business-date helpers — orders are stored as UTC instants, but reporting
// happens on calendar days in the merchant's timezone.

// Intl.DateTimeFormat construction is expensive (~ms) — cache per timezone,
// we format thousands of rows in summary aggregation.
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Calendar date (YYYY-MM-DD) of a UTC instant in the given IANA timezone. */
export function dateInTz(d: Date, timezone: string): string {
  let fmt = fmtCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }); // en-CA formats as YYYY-MM-DD
    fmtCache.set(timezone, fmt);
  }
  return fmt.format(d);
}
