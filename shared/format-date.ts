// The one place dates turn into display strings, on the client and the server.
//
// Two rules, and the whole module exists to keep them straight:
//
// 1. Everything renders in en-US. The site is English-only (month names are
//    never translated, and the marketing copy is written US-first), so letting
//    `toLocaleDateString()` follow the viewer's browser locale only bought us
//    inconsistency — a UK member saw "July 15, 2026" on an episode card and
//    "15/07/2026" on their billing page in the same session.
//
// 2. A *calendar date* is not an *instant*, and they must not share a code path.
//    Our feeds (Simplecast, Beehiiv, Circle) all serialize `publishedAt` as a
//    bare 'YYYY-MM-DD'. Per spec, `new Date('2026-07-15')` parses as UTC
//    midnight, so formatting it in the viewer's zone slid every published date
//    back a day for every reader in the Americas. Calendar dates are therefore
//    parsed as plain digits and never touch a local timezone; instants (Stripe
//    period ends, announcement windows, row timestamps) keep rendering in the
//    viewer's zone, because for those the moment genuinely matters.

const LOCALE = 'en-US'

// Member-facing email is rendered on a server whose ambient zone is UTC, which
// would show a west-of-Greenwich member a date one day ahead of their own. Pin
// an explicit zone instead of inheriting the host's. US-first audience, so ET.
export const EMAIL_TIME_ZONE = 'America/New_York'

/** 'short' → Jul 15, 2026 · 'long' → July 15, 2026 · 'longPadded' → July 05, 2026 */
export type DateStyle = 'short' | 'long' | 'longPadded'

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { month: 'short', day: 'numeric', year: 'numeric' },
  long: { month: 'long', day: 'numeric', year: 'numeric' },
  longPadded: { month: 'long', day: '2-digit', year: 'numeric' },
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
}

// Intl.DateTimeFormat construction is the expensive part, and the reminder cron
// formats one date per member row, so memoize per (style, zone, withTime).
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(
  style: DateStyle,
  timeZone: string | undefined,
  withTime: boolean,
): Intl.DateTimeFormat {
  const key = `${style}|${timeZone ?? ''}|${withTime ? 't' : ''}`
  let f = formatters.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, {
      ...DATE_OPTIONS[style],
      ...(withTime ? TIME_OPTIONS : {}),
      ...(timeZone ? { timeZone } : {}),
    })
    formatters.set(key, f)
  }
  return f
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/

export type CalendarParts = { year: number; month: number; day: number }

/**
 * The leading 'YYYY-MM-DD' of an ISO-ish string, as plain numbers — no Date
 * parsing, so no timezone can shift it. Returns null for anything that isn't a
 * real calendar date, including impossible ones like '2026-02-30'.
 *
 * Exported for callers that need the components rather than a formatted string
 * (e.g. the newsletter issue stamp, which renders "07.15" over "2026").
 */
export function calendarDateParts(
  value: string | null | undefined,
): CalendarParts | null {
  if (!value) return null
  const m = CALENDAR_DATE.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // Round-trip to reject Feb 30 and friends, which the range check above lets by.
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

/**
 * A calendar date ('2026-07-15' → "Jul 15, 2026"). Timezone-free: the date you
 * stored is the date that renders, in every zone. Use for anything whose
 * time-of-day is meaningless — published dates, issue dates, drop dates.
 *
 * Returns '' when the value isn't a parseable date, so callers can omit the line.
 */
export function formatCalendarDate(
  value: string | null | undefined,
  style: DateStyle = 'short',
): string {
  const parts = calendarDateParts(value)
  if (!parts) return ''
  return formatter(style, 'UTC', false).format(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  )
}

/**
 * A real instant, in the viewer's own timezone ("Jul 15, 2026"). Use when the
 * moment matters and should land in local terms — Stripe period ends, renewal
 * dates, admin row timestamps.
 *
 * Returns '' for a missing or unparseable value.
 */
export function formatTimestamp(
  iso: string | null | undefined,
  style: DateStyle = 'short',
): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return ''
  return formatter(style, undefined, false).format(ms)
}

/**
 * A real instant with its clock time, in the viewer's own timezone
 * ("Jul 15, 2026, 9:00 AM"). For admin surfaces where the time of day is part
 * of the record — announcement windows, thread creation.
 */
export function formatTimestampWithTime(iso: string | null | undefined): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return ''
  return formatter('short', undefined, true).format(ms)
}

/**
 * A real instant rendered in an explicit zone. For server-side output (email,
 * crons) where there is no viewer whose zone we could use, and inheriting the
 * host's UTC would misdate the line.
 */
export function formatTimestampInZone(
  iso: string | null | undefined,
  timeZone: string,
  style: DateStyle = 'short',
): string {
  const ms = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) return ''
  return formatter(style, timeZone, false).format(ms)
}
