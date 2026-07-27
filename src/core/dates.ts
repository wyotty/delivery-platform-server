/** Date helpers operating on 'YYYY-MM-DD' business dates (no timezone math). */

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

/** Yesterday in the given IANA timezone, as 'YYYY-MM-DD'. */
export function yesterdayIn(timezone: string, now = new Date()): string {
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  local.setDate(local.getDate() - 1);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const d = String(local.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
