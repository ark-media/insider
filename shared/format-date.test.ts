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
  formatCalendarDate,
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
  // These are the regression cases: under the previous implementation every one
  // of them rendered a day early for any reader in the Americas.
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
})
