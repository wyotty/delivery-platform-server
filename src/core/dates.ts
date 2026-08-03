// Date helpers. Two distinct concepts live here:
//  - business dates: 'YYYY-MM-DD' labels with no timezone math (what report_date holds)
//  - dateInTz: the calendar day a UTC instant falls on in a merchant's timezone

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertBusinessDate(date: string): void {
  if (!DATE_RE.test(date)) {
    throw new Error(`Expected a 'YYYY-MM-DD' business date, got: ${date}`);
  }
}

/**
 * Expand an inclusive range into individual business dates.
 * Uses UTC internally purely as a calendar — these are date labels, not instants,
 * so no timezone offset is applied at any point.
 */
export function eachDate(from: string, to: string): string[] {
  assertBusinessDate(from);
  assertBusinessDate(to);

  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) throw new Error(`Invalid range: ${from} is after ${to}`);

  const dates: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    dates.push(new Date(t).toISOString().slice(0, 10));
  }
  return dates;
}

// Intl.DateTimeFormat construction is expensive (~ms) — cache per timezone.
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
