// Support availability: a tenant's weekly hours, overridden for a while by an
// operator's on/off toggle. Pure; the routes read the config and the override
// from KV and pass them in.

export interface AvailabilityConfig {
  /** IANA zone the hours are in, e.g. "America/Denver". Daylight saving follows it. */
  timezone: string;
  /** Open blocks. days: 0=Sun..6=Sat; start/end "HH:MM", end exclusive, start < end. */
  hours: { days: number[]; start: string; end: string }[];
  /** "YYYY-MM-DD" in `timezone`, closed all day. */
  holidays?: string[];
}

/** The toggle. Wins over the hours while `until` (epoch ms) is in the future. */
export interface AvailabilityOverride {
  online: boolean;
  until: number;
}

export interface Availability {
  online: boolean;
  source: "toggle" | "hours";
  /** When offline, the next moment someone is expected; null when online or unknown. */
  nextOnlineAt: number | null;
  /** When this status next changes; for the operator's status reply. */
  changesAt: number | null;
}

export const TOGGLE_ON_MS = 4 * 60 * 60_000;
export const TOGGLE_OFF_FALLBACK_MS = 24 * 60 * 60_000;
export const kAvailability = (tenantId: string) => `availability:${tenantId}`;

// ponytail: looks two weeks ahead; a longer closure reports "unknown" (null).
const SEARCH_DAYS = 14;

function wallClock(ms: number, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(ms)
      .map((x) => [x.type, x.value]),
  );
  const n = (k: string) => Number(p[k]);
  return { y: n("year"), m: n("month"), d: n("day"), h: n("hour"), min: n("minute"), s: n("second") };
}

/** The zone's offset from UTC at `ms`: its wall clock read as UTC, minus the instant. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - (ms - (((ms % 1000) + 1000) % 1000));
}

/** The instant a local wall-clock time happens. A second pass corrects across a daylight-saving change. */
function instant(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  const first = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(first, timeZone);
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const pad = (n: number) => String(n).padStart(2, "0");

/** Open intervals [start, end) that haven't ended by `now`, soonest first. */
function openings(config: AvailabilityConfig, now: number): [number, number][] {
  const today = wallClock(now, config.timezone);
  const holidays = new Set(config.holidays ?? []);
  const out: [number, number][] = [];
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    // Calendar arithmetic on the local date; UTC here is just a date container.
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (holidays.has(`${y}-${pad(m)}-${pad(d)}`)) continue;
    for (const b of config.hours) {
      if (!b.days.includes(day.getUTCDay())) continue;
      out.push([
        instant(y, m, d, toMinutes(b.start), config.timezone),
        instant(y, m, d, toMinutes(b.end), config.timezone),
      ]);
    }
  }
  return (
    out
      .filter(([, end]) => end > now)
      // eslint-disable-next-line unicorn/no-array-sort -- filter made a fresh array (toSorted needs a newer TS lib)
      .sort((a, b) => a[0] - b[0])
  );
}

export function availabilityAt(
  config: AvailabilityConfig,
  override: AvailabilityOverride | null,
  now: number,
): Availability {
  if (override && override.until > now) {
    if (override.online)
      return { online: true, source: "toggle", nextOnlineAt: null, changesAt: override.until };
    const after = openings(config, override.until)[0];
    return {
      online: false,
      source: "toggle",
      nextOnlineAt: after ? Math.max(after[0], override.until) : null,
      changesAt: override.until,
    };
  }
  const blocks = openings(config, now);
  const current = blocks.find(([start]) => start <= now);
  if (current) return { online: true, source: "hours", nextOnlineAt: null, changesAt: current[1] };
  const next = blocks[0]?.[0] ?? null;
  return { online: false, source: "hours", nextOnlineAt: next, changesAt: next };
}

/** The next scheduled opening strictly after `now`, or null within the search window. */
export function nextOpening(config: AvailabilityConfig, now: number): number | null {
  return openings(config, now).find(([start]) => start > now)?.[0] ?? null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Validates a config written through the tenant config route. */
export function availabilityConfigError(value: unknown): string | null {
  const bad = "invalid_availability";
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad;
  const c = value as Partial<AvailabilityConfig>;
  if (typeof c.timezone !== "string" || !c.timezone) return bad;
  try {
    if (!new Intl.DateTimeFormat("en-US", { timeZone: c.timezone }).resolvedOptions().timeZone)
      return bad;
  } catch {
    return bad;
  }
  if (!Array.isArray(c.hours) || c.hours.length > 21) return bad;
  for (const b of c.hours) {
    if (!b || typeof b !== "object") return bad;
    if (!Array.isArray(b.days) || !b.days.length) return bad;
    if (!b.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return bad;
    if (typeof b.start !== "string" || typeof b.end !== "string") return bad;
    if (!HHMM.test(b.start) || !HHMM.test(b.end) || b.start >= b.end) return bad;
  }
  if (c.holidays !== undefined) {
    if (!Array.isArray(c.holidays) || c.holidays.length > 100) return bad;
    if (!c.holidays.every((h) => typeof h === "string" && DATE.test(h))) return bad;
  }
  return null;
}

/** "Monday, 9:00 AM Mountain Time", or "3:40 PM Mountain Time" without the day. */
export function formatInZone(ms: number, timeZone: string, withDay = true): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...(withDay ? { weekday: "long" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "longGeneric",
  }).format(ms);
}

/** One instruction for this turn: whether a person can reply now, and what to offer. */
export function availabilityBlock(
  config: AvailabilityConfig | undefined,
  override: AvailabilityOverride | null,
  now: number,
): string {
  if (!config) return "";
  const a = availabilityAt(config, override, now);
  if (a.online)
    return "\n\nA teammate is online now. If you hand off, say a teammate will reply here shortly. Don't offer email or contact forms.";
  const next =
    a.nextOnlineAt === null
      ? ""
      : ` The next is expected ${formatInZone(a.nextOnlineAt, config.timezone)}.`;
  return `\n\nNo teammate is online right now.${next} If you hand off, say when to expect a reply and offer the email form if one is configured.`;
}
