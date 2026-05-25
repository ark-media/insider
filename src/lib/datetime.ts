// Timezone-aware bridge between `<input type="datetime-local">` (a zoneless
// wall-clock string) and the UTC ISO instants the API stores. The admin picks
// an explicit IANA zone, so "9:00" means 9:00 in *that* zone — not in whatever
// timezone the admin's laptop happens to be set to.
//
// Announcement windows are absolute instants (the server compares them against
// `now` in UTC), so all the timezone knows about lives here, on the write side.

// A curated set for a US-audience admin, plus UTC. The browser's own zone is
// added at runtime by the form if it isn't already in this list.
export const COMMON_TIME_ZONES: { value: string; label: string }[] = [
  { value: "America/New_York", label: "Eastern — New York" },
  { value: "America/Chicago", label: "Central — Chicago" },
  { value: "America/Denver", label: "Mountain — Denver" },
  { value: "America/Phoenix", label: "Mountain, no DST — Phoenix" },
  { value: "America/Los_Angeles", label: "Pacific — Los Angeles" },
  { value: "America/Anchorage", label: "Alaska — Anchorage" },
  { value: "Pacific/Honolulu", label: "Hawaii — Honolulu" },
  { value: "UTC", label: "UTC" },
];

export const DEFAULT_TIME_ZONE = "America/New_York";

// The zone the admin's browser is set to (e.g. "America/Los_Angeles").
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

// Offset (zone − UTC) in minutes at a given instant. Derived by formatting the
// instant *in* the zone and diffing against the raw UTC value of those same
// wall-clock fields — the standard Intl trick, since JS has no zoned-time type.
function zoneOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hour = get("hour") === 24 ? 0 : get("hour"); // some engines emit "24" at midnight
  const asUTC = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
  return (asUTC - instant.getTime()) / 60000;
}

// Wall-clock string ("2026-05-26T09:00") interpreted in `timeZone` → UTC ISO.
export function zonedWallClockToUtc(wallClock: string, timeZone: string): string {
  const m = WALL_CLOCK.exec(wallClock);
  if (!m) throw new Error(`Invalid datetime-local value: ${wallClock}`);
  const [, y, mo, d, h, mi] = m.map(Number);
  // Treat the wall clock as if it were UTC, then shift by the zone's offset.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = zoneOffsetMinutes(timeZone, new Date(guess));
  let utc = guess - offset * 60000;
  // Across a DST transition the offset at `guess` and at the corrected instant
  // differ; re-derive once at the corrected instant to land on the right side.
  const corrected = zoneOffsetMinutes(timeZone, new Date(utc));
  if (corrected !== offset) utc = guess - corrected * 60000;
  return new Date(utc).toISOString();
}

// UTC ISO → wall-clock string ("2026-05-26T09:00") as seen in `timeZone`.
export function utcToZonedWallClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

// Human-readable rendering of an instant in a given zone, for confirmation
// hints (e.g. "May 26, 2026, 9:00 AM EDT").
export function describeInstant(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleString("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  });
}
