export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();

/** Offset of `timeZone` from UTC, in minutes, at the given instant (positive east of UTC). */
function zoneOffsetMinutes(timeZone: string, instant: number): number {
  const cacheKey = `${timeZone}|${Math.floor(instant / (15 * MINUTE))}`;
  const cached = offsetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instant))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  const offset = Math.round((asUtc - instant) / MINUTE);
  offsetCache.set(cacheKey, offset);
  return offset;
}

/**
 * The UTC instant of a wall-clock time in a time zone. In a spring-forward gap the result lands
 * after the gap, as phones do; in a fall-back overlap it picks the first occurrence.
 */
export function zonedToUtc(day: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h ?? 0, m ?? 0);
  const first = guess - zoneOffsetMinutes(timeZone, guess) * MINUTE;
  const second = guess - zoneOffsetMinutes(timeZone, first) * MINUTE;
  return new Date(Math.min(first, second));
}

/** The calendar day (as a UTC-midnight Date) that `instant` falls on in `timeZone`. */
export function localDay(instant: Date, timeZone: string): Date {
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(timeZone, instant.getTime()) * MINUTE);
  return startOfUtcDay(shifted);
}
