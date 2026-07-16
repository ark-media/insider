// Unit tests for the shared reminder-config validator. Pure — the same rules
// run on the client (admin form) and server (PUT handler).

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_REMINDER_CONFIG,
  REMINDER_LIMITS,
  validateReminderConfig,
} from './feed-reminder'

describe('validateReminderConfig', () => {
  test('accepts the defaults', () => {
    const v = validateReminderConfig(DEFAULT_REMINDER_CONFIG)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.value).toEqual(DEFAULT_REMINDER_CONFIG)
  })

  test('rejects a non-object', () => {
    expect(validateReminderConfig(null).ok).toBe(false)
    expect(validateReminderConfig('x').ok).toBe(false)
  })

  test('requires boolean enabled / onlyIfNoneSetUp', () => {
    expect(
      validateReminderConfig({ ...DEFAULT_REMINDER_CONFIG, enabled: 'yes' }).ok,
    ).toBe(false)
    expect(
      validateReminderConfig({ ...DEFAULT_REMINDER_CONFIG, onlyIfNoneSetUp: 1 }).ok,
    ).toBe(false)
  })

  test('rejects non-integer / out-of-range delayHours', () => {
    expect(validateReminderConfig({ ...DEFAULT_REMINDER_CONFIG, delayHours: 1.5 }).ok).toBe(false)
    expect(validateReminderConfig({ ...DEFAULT_REMINDER_CONFIG, delayHours: -1 }).ok).toBe(false)
    expect(
      validateReminderConfig({
        ...DEFAULT_REMINDER_CONFIG,
        delayHours: REMINDER_LIMITS.delayHoursMax + 1,
        windowDays: 365,
      }).ok,
    ).toBe(false)
  })

  test('rejects windowDays below 1 or above the max', () => {
    expect(validateReminderConfig({ ...DEFAULT_REMINDER_CONFIG, windowDays: 0 }).ok).toBe(false)
    expect(
      validateReminderConfig({
        ...DEFAULT_REMINDER_CONFIG,
        windowDays: REMINDER_LIMITS.windowDaysMax + 1,
      }).ok,
    ).toBe(false)
  })

  test('rejects a window shorter than the delay', () => {
    // 1 day window (24h) < 48h delay → impossible to satisfy.
    const v = validateReminderConfig({
      enabled: true,
      delayHours: 48,
      windowDays: 1,
      onlyIfNoneSetUp: true,
    })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toContain('window')
  })

  test('allows delayHours 0 (remind immediately on next run)', () => {
    const v = validateReminderConfig({
      enabled: true,
      delayHours: 0,
      windowDays: 7,
      onlyIfNoneSetUp: false,
    })
    expect(v.ok).toBe(true)
  })

  test('strips unknown fields (returns only the four known keys)', () => {
    const v = validateReminderConfig({
      ...DEFAULT_REMINDER_CONFIG,
      injected: 'nope',
    })
    expect(v.ok).toBe(true)
    if (v.ok) expect(Object.keys(v.value).sort()).toEqual([
      'delayHours',
      'enabled',
      'onlyIfNoneSetUp',
      'windowDays',
    ])
  })
})
