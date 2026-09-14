// The migration campaign's clock and validator. Pure, so every scheduling rule
// is pinned on its own — these decide which of three escalating emails a member
// gets, and on which day, so getting them wrong is visible to every migrated
// member at once.

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_MIGRATION_CONFIG,
  MIGRATION_REMINDER_NO,
  calendarDateMs,
  dueStage,
  migrationSchedule,
  validateMigrationConfig,
  type MigrationConfig,
} from './feed-migration'
import { DEFAULT_REMINDER_CONFIG } from './feed-reminder'

const CONFIG: MigrationConfig = {
  enabled: true,
  launchDate: '2026-09-10',
  deadlineDate: '2026-12-31',
  firstCheckInDays: 30,
  secondCheckInDays: 60,
  finalNoticeDays: 5,
}

const at = (d: string) => Date.parse(`${d}T12:00:00Z`)

describe('calendarDateMs', () => {
  test('parses a calendar date at UTC midnight', () => {
    expect(calendarDateMs('2026-12-31')).toBe(Date.parse('2026-12-31T00:00:00Z'))
  })

  test('rejects impossible and malformed dates rather than rolling them forward', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-1', 'December 31', '']) {
      expect(calendarDateMs(bad)).toBeNull()
    }
  })
})

describe('migrationSchedule', () => {
  test('the three stages land where the config says', () => {
    const s = migrationSchedule(CONFIG)
    expect(s.map((x) => new Date(x.dueMs).toISOString().slice(0, 10))).toEqual([
      '2026-10-10', // launch + 30
      '2026-11-09', // launch + 60
      '2026-12-26', // deadline − 5
    ])
  })

  test('an unparseable date yields no schedule rather than a guess', () => {
    expect(migrationSchedule({ ...CONFIG, launchDate: 'nope' })).toEqual([])
  })
})

describe('dueStage', () => {
  test('nothing before the first check-in comes due', () => {
    expect(dueStage(CONFIG, at('2026-10-09'))).toBeNull()
  })

  test('each stage takes over on its own day', () => {
    expect(dueStage(CONFIG, at('2026-10-10'))).toBe('check_in_30')
    expect(dueStage(CONFIG, at('2026-11-08'))).toBe('check_in_30')
    expect(dueStage(CONFIG, at('2026-11-09'))).toBe('check_in_60')
    expect(dueStage(CONFIG, at('2026-12-25'))).toBe('check_in_60')
    expect(dueStage(CONFIG, at('2026-12-26'))).toBe('final')
  })

  test('a missed run delivers the latest stage, never a backlog', () => {
    // The cron is down through the 30-day mark and first runs on day 65. The
    // 60-day email is the accurate description of where that member is; sending
    // both on one morning would read as a mistake.
    expect(dueStage(CONFIG, at('2026-11-14'))).toBe('check_in_60')
  })

  test('the campaign goes quiet once the deadline has passed', () => {
    // "Five days left" in January is worse than silence — the thing it was
    // protecting is already gone.
    expect(dueStage(CONFIG, at('2027-01-05'))).toBeNull()
  })

  test('disabled means nothing is ever due', () => {
    expect(dueStage({ ...CONFIG, enabled: false }, at('2026-12-26'))).toBeNull()
  })

  test('an unparseable deadline stops the campaign rather than running it blind', () => {
    expect(dueStage({ ...CONFIG, deadlineDate: 'soon' }, at('2026-12-26'))).toBeNull()
  })
})

describe('validateMigrationConfig', () => {
  test('accepts the defaults it ships with', () => {
    const v = validateMigrationConfig(DEFAULT_MIGRATION_CONFIG)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toEqual(DEFAULT_MIGRATION_CONFIG)
  })

  test('rejects a non-object, a bad date, and a deadline before launch', () => {
    expect(validateMigrationConfig(null).ok).toBe(false)
    expect(validateMigrationConfig({ ...CONFIG, launchDate: '10/09/2026' }).ok).toBe(false)
    expect(
      validateMigrationConfig({ ...CONFIG, deadlineDate: '2026-09-01' }).ok,
    ).toBe(false)
  })

  test('rejects out-of-order check-ins', () => {
    const v = validateMigrationConfig({
      ...CONFIG,
      firstCheckInDays: 60,
      secondCheckInDays: 30,
    })
    expect(v.ok).toBe(false)
  })

  test('rejects a final notice that would land before the second check-in', () => {
    // Otherwise the series escalates and then de-escalates: "benefits at risk"
    // would arrive after "last call".
    const v = validateMigrationConfig({ ...CONFIG, finalNoticeDays: 90 })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('before the second check-in')
  })

  test('rejects fractional and negative day counts', () => {
    expect(validateMigrationConfig({ ...CONFIG, firstCheckInDays: 30.5 }).ok).toBe(false)
    expect(validateMigrationConfig({ ...CONFIG, finalNoticeDays: -1 }).ok).toBe(false)
  })
})

describe('ledger numbering', () => {
  test('the migration stages never collide with the feed-setup reminder', () => {
    // Both campaigns write to feed_reminder_sends, whose PK is
    // (email, reminder_no). The setup reminder owns 1; if a stage took that
    // number, one campaign would silently suppress the other.
    expect(Object.values(MIGRATION_REMINDER_NO)).not.toContain(1)
    expect(new Set(Object.values(MIGRATION_REMINDER_NO)).size).toBe(3)
  })

  test('both campaigns are on by default', () => {
    expect(DEFAULT_MIGRATION_CONFIG.enabled).toBe(true)
    expect(DEFAULT_REMINDER_CONFIG.enabled).toBe(true)
  })
})
