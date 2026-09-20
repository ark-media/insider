// Unit tests for the shared date formatters.
//
// The important property here is that `formatCalendarDate` is *timezone-free*.
// These assertions are written so they hold under any ambient TZ — run the file
// under TZ=Pacific/Midway (UTC-11) and TZ=Pacific/Kiritimati (UTC+14) and it
// must pass identically. The old `new Date(iso).toLocaleDateString()` code path
// fails the calendar cases in every zone behind UTC.
//
// Local-zone assertions deliberately check shape, not a specific day, since the
// correct answer there genuinely depends on where the test runs.

import { describe, test, expect } from 'bun:test'
import {
  EMAIL_TIME_ZONE,
  calendarDateParts,
  calendarDaysUntilInZone,
  formatCalendarDate,
  formatEventParts,
  formatTimestamp,
  formatTimestampInZone,
  formatTimestampWithTime,
} from './format-date'

const EN_US_SHORT = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/

describe('calendarDateParts', () => {
  test('reads the leading YYYY-MM-DD as plain numbers', () => {
    expect(calendarDateParts('2026-07-15')).toEqual({ year: 2026, month: 7, day: 15 })
  })

  test('ignores any time component that follows', () => {
    expect(calendarDateParts('2026-07-15T23:30:00Z')).toEqual({
      year: 2026,
      month: 7,
      day: 15,
    })
    // A late-evening negative-offset instant must not roll the date forward.
    expect(calendarDateParts('2026-07-15T23:30:00-05:00')?.day).toBe(15)
  })

  test('rejects impossible and malformed dates', () => {
    expect(calendarDateParts('2026-02-30')).toBeNull()
    expect(calendarDateParts('2026-13-01')).toBeNull()
    expect(calendarDateParts('2026-00-10')).toBeNull()
    expect(calendarDateParts('2026-07-00')).toBeNull()
    expect(calendarDateParts('07/15/2026')).toBeNull()
    expect(calendarDateParts('not a date')).toBeNull()
    expect(calendarDateParts('')).toBeNull()
    expect(calendarDateParts(null)).toBeNull()
    expect(calendarDateParts(undefined)).toBeNull()
  })

  test('accepts a real leap day and rejects a fake one', () => {
    expect(calendarDateParts('2028-02-29')?.day).toBe(29)
    expect(calendarDateParts('2026-02-29')).toBeNull()
  })
})

describe('formatCalendarDate', () => {
  // These are the regression cases: a YYYY-MM-DD calendar date must render
  // that day, whatever zone the runtime is in.
  test('renders the stored date, whatever zone the runtime is in', () => {
    expect(formatCalendarDate('2026-07-15')).toBe('Jul 15, 2026')
    expect(formatCalendarDate('2026-01-01')).toBe('Jan 1, 2026')
    expect(formatCalendarDate('2026-12-31')).toBe('Dec 31, 2026')
  })

  test('supports the long and padded styles', () => {
    expect(formatCalendarDate('2026-07-15', 'long')).toBe('July 15, 2026')
    expect(formatCalendarDate('2026-07-05', 'longPadded')).toBe('July 05, 2026')
    expect(formatCalendarDate('2026-07-15', 'longPadded')).toBe('July 15, 2026')
  })

  test('is US-formatted regardless of the host locale', () => {
    // Month-name-first is the tell: a locale-following formatter would emit
    // "15.07.2026" or "15/07/2026" here on a de-DE or en-GB runtime.
    expect(formatCalendarDate('2026-07-15')).toMatch(EN_US_SHORT)
  })

  test('returns an empty string for anything unparseable', () => {
    expect(formatCalendarDate(null)).toBe('')
    expect(formatCalendarDate(undefined)).toBe('')
    expect(formatCalendarDate('')).toBe('')
    expect(formatCalendarDate('nonsense')).toBe('')
    expect(formatCalendarDate('2026-02-30')).toBe('')
  })
})

describe('formatTimestamp', () => {
  test('renders a real instant in en-US short form', () => {
    expect(formatTimestamp('2026-07-15T12:00:00Z')).toMatch(EN_US_SHORT)
  })

  test('honours the long style', () => {
    expect(formatTimestamp('2026-07-15T12:00:00Z', 'long')).toMatch(
      /^[A-Z][a-z]+ \d{1,2}, \d{4}$/,
    )
  })

  test('returns an empty string for a missing or bad value', () => {
    expect(formatTimestamp(null)).toBe('')
    expect(formatTimestamp(undefined)).toBe('')
    expect(formatTimestamp('')).toBe('')
    expect(formatTimestamp('nonsense')).toBe('')
  })
})

describe('formatTimestampWithTime', () => {
  test('includes a clock time alongside the date', () => {
    // en-US joins the two with " at " on current ICU and ", " on older builds;
    // accept either so the suite isn't pinned to a CLDR version.
    expect(formatTimestampWithTime('2026-07-15T12:00:00Z')).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{4}(,| at) \d{1,2}:\d{2}\s?(AM|PM)$/i,
    )
  })

  test('returns an empty string for a missing or bad value', () => {
    expect(formatTimestampWithTime(null)).toBe('')
    expect(formatTimestampWithTime('nonsense')).toBe('')
  })
})

describe('formatTimestampInZone', () => {
  // Deterministic anywhere, because the zone is explicit rather than ambient —
  // this is what keeps server-rendered email off the host's UTC clock.
  test('resolves the date in the given zone, not the host zone', () => {
    // 02:00 UTC on Aug 3 is still Aug 2 in New York.
    expect(formatTimestampInZone('2026-08-03T02:00:00Z', EMAIL_TIME_ZONE)).toBe(
      'Aug 2, 2026',
    )
    expect(formatTimestampInZone('2026-08-03T02:00:00Z', 'UTC')).toBe('Aug 3, 2026')
  })

  test('handles the long style used in member email', () => {
    expect(
      formatTimestampInZone('2026-08-03T16:00:00Z', EMAIL_TIME_ZONE, 'long'),
    ).toBe('August 3, 2026')
  })

  test('returns an empty string for a missing or bad value', () => {
    expect(formatTimestampInZone(null, EMAIL_TIME_ZONE)).toBe('')
    expect(formatTimestampInZone('nonsense', EMAIL_TIME_ZONE)).toBe('')
  })

  test('appends the zone label on request, without an " at " separator', () => {
    const out = formatTimestampInZone('2026-08-20T16:00:00Z', EMAIL_TIME_ZONE, 'long', {
      withZoneLabel: true,
    })
    expect(out).toBe('August 20, 2026 ET')
    expect(out).not.toContain(' at ')
  })

  test('uses the DST-stable generic label, so summer and winter read alike', () => {
    const opts = { withZoneLabel: true } as const
    // 'short' would give EDT here and EST in January; only the date is shown, so
    // that extra precision would be noise the reader has to decode.
    expect(
      formatTimestampInZone('2026-08-20T16:00:00Z', EMAIL_TIME_ZONE, 'long', opts),
    ).toContain('ET')
    expect(
      formatTimestampInZone('2026-01-20T16:00:00Z', EMAIL_TIME_ZONE, 'long', opts),
    ).toContain('ET')
  })

  test('omits the label by default', () => {
    expect(formatTimestampInZone('2026-08-20T16:00:00Z', EMAIL_TIME_ZONE, 'long')).toBe(
      'August 20, 2026',
    )
  })
})

describe('calendarDaysUntilInZone', () => {
  const TZ = 'America/New_York'
  // 2026-08-13 12:00 ET. Every case below is measured from here.
  const NOW = Date.parse('2026-08-13T16:00:00Z')

  test('counts whole calendar days in the given zone', () => {
    expect(calendarDaysUntilInZone('2026-08-20T16:00:00Z', NOW, TZ)).toBe(7)
    expect(calendarDaysUntilInZone('2026-08-14T16:00:00Z', NOW, TZ)).toBe(1)
    expect(calendarDaysUntilInZone('2026-08-13T20:00:00Z', NOW, TZ)).toBe(0)
  })

  test('counts the calendar date, not elapsed 24h blocks', () => {
    // 6.5 elapsed days, but 03:00 UTC is still Aug 19 in ET — so the date shown
    // is Aug 19 and the count must say 6, not round 6.5 up to 7.
    const iso = '2026-08-20T03:00:00Z'
    expect(formatTimestampInZone(iso, TZ, 'long')).toBe('August 19, 2026')
    expect(calendarDaysUntilInZone(iso, NOW, TZ)).toBe(6)
  })

  test('is measured in the target zone, not the host zone', () => {
    // Same instant, two zones, two different calendar dates → two counts.
    const iso = '2026-08-20T03:00:00Z'
    expect(calendarDaysUntilInZone(iso, NOW, 'America/New_York')).toBe(6)
    expect(calendarDaysUntilInZone(iso, NOW, 'UTC')).toBe(7)
  })

  test('stays exact across a DST transition', () => {
    // US DST ends 2026-11-01. Spanning it must not drift by the extra hour.
    const from = Date.parse('2026-10-28T16:00:00Z')
    expect(calendarDaysUntilInZone('2026-11-04T17:00:00Z', from, TZ)).toBe(7)
  })

  test('goes negative for a past instant', () => {
    expect(calendarDaysUntilInZone('2026-08-10T16:00:00Z', NOW, TZ)).toBe(-3)
  })

  test('returns null for a missing or bad value', () => {
    expect(calendarDaysUntilInZone(null, NOW, TZ)).toBeNull()
    expect(calendarDaysUntilInZone('nonsense', NOW, TZ)).toBeNull()
  })
})

describe('formatEventParts', () => {
  // Pinned to an explicit zone, so these assertions hold wherever the suite runs.
  const TZ_NY = 'America/New_York'

  test('splits an instant into a weekday-led date and a zoned time', () => {
    expect(formatEventParts('2026-10-14T16:00:00Z', TZ_NY)).toEqual({
      date: 'Wednesday, October 14',
      time: '12:00 PM EDT',
    })
  })

  test('renders the same instant in another zone', () => {
    expect(formatEventParts('2026-10-14T16:00:00Z', 'Asia/Jerusalem')).toEqual({
      date: 'Wednesday, October 14',
      time: '7:00 PM GMT+3',
    })
  })

  test('crosses the date line into the next day where the zone does', () => {
    // 11pm ET on the 14th is 6am on the 15th in Jerusalem.
    expect(formatEventParts('2026-10-15T03:00:00Z', 'Asia/Jerusalem')?.date).toBe(
      'Thursday, October 15',
    )
    expect(formatEventParts('2026-10-15T03:00:00Z', TZ_NY)?.date).toBe(
      'Wednesday, October 14',
    )
  })

  test('names the standard-time zone after the DST transition', () => {
    // US DST ends 2026-11-01, so a November session is EST, not EDT.
    expect(formatEventParts('2026-11-11T17:00:00Z', TZ_NY)?.time).toBe(
      '12:00 PM EST',
    )
  })

  test('omitting the zone renders in the viewer\'s own', () => {
    const parts = formatEventParts('2026-10-14T16:00:00Z')
    // Shape, not a specific day — the right answer depends on where this runs.
    expect(parts?.date).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/)
    expect(parts?.time).toMatch(/^\d{1,2}:\d{2} (AM|PM) .+$/)
  })

  test('returns null for a missing or unreadable value', () => {
    expect(formatEventParts(null)).toBeNull()
    expect(formatEventParts('nonsense')).toBeNull()
  })
})
