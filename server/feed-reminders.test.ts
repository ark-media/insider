// Unit tests for the feed-setup reminder decision logic and email rendering.
// The pure functions (memberInWindow / evaluateReminder / loadReminderConfigFromEnv)
// carry the rules, so they're tested here without SC, the DB, or Resend. The
// cron route's auth + wiring is covered in feed-reminders-cron.test.ts.

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_REMINDER_CONFIG,
  evaluateReminder,
  loadReminderConfigFromEnv,
  memberInWindow,
  memberStatusEligible,
  passesCheapGate,
  type ReminderConfig,
} from './lib/feed-reminders'
import { renderFeedReminderEmail } from './lib/feed-reminder-email'
import type { ScMembership } from './lib/sc-client'

const NOW = Date.parse('2026-07-16T12:00:00Z')
const HOUR = 3_600_000
const DAY = 86_400_000

function member(over: Partial<ScMembership> = {}): ScMembership {
  return {
    id: 1,
    user_id: 1,
    email: 'a@x.com',
    first_name: 'Ada',
    status: 'active',
    joined: new Date(NOW - 3 * DAY).toISOString(),
    feeds: [
      { id: 10, name: 'Show A', url: 'u' },
      { id: 20, name: 'Show B', url: 'u' },
    ],
    ...over,
  }
}

// ===========================================================================
// memberInWindow
// ===========================================================================

describe('memberInWindow', () => {
  const cfg = DEFAULT_REMINDER_CONFIG // delay 24h, window 14d

  test('too new (joined 2h ago) is out', () => {
    const joined = new Date(NOW - 2 * HOUR).toISOString()
    expect(memberInWindow(joined, cfg, NOW)).toBe(false)
  })

  test('just past the delay (joined 25h ago) is in', () => {
    const joined = new Date(NOW - 25 * HOUR).toISOString()
    expect(memberInWindow(joined, cfg, NOW)).toBe(true)
  })

  test('inside the window (joined 5d ago) is in', () => {
    const joined = new Date(NOW - 5 * DAY).toISOString()
    expect(memberInWindow(joined, cfg, NOW)).toBe(true)
  })

  test('older than the window (joined 20d ago) is out', () => {
    const joined = new Date(NOW - 20 * DAY).toISOString()
    expect(memberInWindow(joined, cfg, NOW)).toBe(false)
  })

  test('missing or unparseable joined is out', () => {
    expect(memberInWindow(undefined, cfg, NOW)).toBe(false)
    expect(memberInWindow('not-a-date', cfg, NOW)).toBe(false)
  })
})

// ===========================================================================
// memberStatusEligible
// ===========================================================================

describe('memberStatusEligible', () => {
  test('active / trialing / unknown / blank are eligible (fail-open)', () => {
    expect(memberStatusEligible('active')).toBe(true)
    expect(memberStatusEligible('trialing')).toBe(true)
    expect(memberStatusEligible('some_new_status')).toBe(true)
    expect(memberStatusEligible(undefined)).toBe(true)
  })

  test('cancelled / expired / refunded (any case) are skipped', () => {
    expect(memberStatusEligible('cancelled')).toBe(false)
    expect(memberStatusEligible('Canceled')).toBe(false)
    expect(memberStatusEligible('EXPIRED')).toBe(false)
    expect(memberStatusEligible('refunded')).toBe(false)
  })
})

// ===========================================================================
// passesCheapGate
// ===========================================================================

describe('passesCheapGate', () => {
  // DEFAULT is enabled:false (opt-in); these cases test the other gates, so
  // start from an enabled config.
  const cfg = { ...DEFAULT_REMINDER_CONFIG, enabled: true }

  test('active in-window member with feeds passes', () => {
    expect(passesCheapGate(member(), cfg, NOW)).toBe(true)
  })

  test('member with no feeds is gated out', () => {
    expect(passesCheapGate(member({ feeds: [] }), cfg, NOW)).toBe(false)
  })

  test('cancelled member is gated out', () => {
    expect(passesCheapGate(member({ status: 'cancelled' }), cfg, NOW)).toBe(false)
  })

  test('disabled config gates everyone out', () => {
    expect(passesCheapGate(member(), { ...cfg, enabled: false }, NOW)).toBe(false)
  })
})

// ===========================================================================
// evaluateReminder
// ===========================================================================

describe('evaluateReminder', () => {
  // enabled:true (DEFAULT is opt-in off); onlyIfNoneSetUp = true.
  const cfg = { ...DEFAULT_REMINDER_CONFIG, enabled: true }

  test('zero feeds set up → candidate with doneCount 0', () => {
    const c = evaluateReminder(member(), new Set(), false, cfg, NOW)
    expect(c).not.toBeNull()
    expect(c).toMatchObject({ email: 'a@x.com', firstName: 'Ada', doneCount: 0, total: 2 })
  })

  test('all feeds set up → null (nothing to nudge)', () => {
    const c = evaluateReminder(member(), new Set([10, 20]), false, cfg, NOW)
    expect(c).toBeNull()
  })

  test('partial setup with onlyIfNoneSetUp=true → null', () => {
    const c = evaluateReminder(member(), new Set([10]), false, cfg, NOW)
    expect(c).toBeNull()
  })

  test('partial setup with onlyIfNoneSetUp=false → candidate with doneCount 1', () => {
    const relaxed: ReminderConfig = { ...cfg, onlyIfNoneSetUp: false }
    const c = evaluateReminder(member(), new Set([10]), false, relaxed, NOW)
    expect(c).toMatchObject({ doneCount: 1, total: 2 })
  })

  test('already sent → null', () => {
    const c = evaluateReminder(member(), new Set(), true, cfg, NOW)
    expect(c).toBeNull()
  })

  test('out of window → null even with zero setup', () => {
    const old = member({ joined: new Date(NOW - 30 * DAY).toISOString() })
    expect(evaluateReminder(old, new Set(), false, cfg, NOW)).toBeNull()
  })

  test('normalizes email (trims + lowercases)', () => {
    const c = evaluateReminder(
      member({ email: '  Ada@X.COM  ' }),
      new Set(),
      false,
      cfg,
      NOW,
    )
    expect(c?.email).toBe('ada@x.com')
  })

  test('blank first name yields undefined (email falls back to "Hi there")', () => {
    const c = evaluateReminder(member({ first_name: '   ' }), new Set(), false, cfg, NOW)
    expect(c?.firstName).toBeUndefined()
  })

  test('a whole name in SC first_name greets by the leading token only', () => {
    // findOrCreateScUser used to drop the entire name hint into first_name, so
    // the migrated roster has records shaped like this. Greeting verbatim ships
    // "Hi Ada Lovelace," to every one of them.
    const c = evaluateReminder(
      member({ first_name: 'Ada Lovelace' }),
      new Set(),
      false,
      cfg,
      NOW,
    )
    expect(c?.firstName).toBe('Ada')
  })
})

// ===========================================================================
// loadReminderConfigFromEnv
// ===========================================================================

describe('loadReminderConfigFromEnv', () => {
  test('empty env → defaults', () => {
    expect(loadReminderConfigFromEnv({})).toEqual(DEFAULT_REMINDER_CONFIG)
  })

  test('env overrides are applied', () => {
    const cfg = loadReminderConfigFromEnv({
      FEED_REMINDER_ENABLED: 'false',
      FEED_REMINDER_DELAY_HOURS: '48',
      FEED_REMINDER_WINDOW_DAYS: '30',
      FEED_REMINDER_ONLY_IF_NONE: 'false',
    })
    expect(cfg).toEqual({
      enabled: false,
      delayHours: 48,
      windowDays: 30,
      onlyIfNoneSetUp: false,
    })
  })

  test('non-numeric / negative values fall back to defaults', () => {
    const cfg = loadReminderConfigFromEnv({
      FEED_REMINDER_DELAY_HOURS: 'abc',
      FEED_REMINDER_WINDOW_DAYS: '-5',
    })
    expect(cfg.delayHours).toBe(DEFAULT_REMINDER_CONFIG.delayHours)
    expect(cfg.windowDays).toBe(DEFAULT_REMINDER_CONFIG.windowDays)
  })
})

// ===========================================================================
// renderFeedReminderEmail
// ===========================================================================

describe('renderFeedReminderEmail', () => {
  const setupUrl = 'https://ark.example/account/podcast-feed'

  test('zero setup → "get started" framing', () => {
    const { subject, html } = renderFeedReminderEmail({
      firstName: 'Ada',
      doneCount: 0,
      total: 6,
      setupUrl,
    })
    expect(subject).toBe('Finish setting up your Ark+ feeds')
    expect(html).toContain('Hi Ada,')
    expect(html).toContain('all 6 shows')
    expect(html).toContain(setupUrl)
    expect(html).toContain('Set up my feeds')
  })

  test('partial setup → "N shows away" framing with correct pluralization', () => {
    const one = renderFeedReminderEmail({ doneCount: 5, total: 6, setupUrl })
    expect(one.subject).toBe("You're 1 show away from the full network")
    expect(one.html).toContain('Hi there,') // no first name

    const many = renderFeedReminderEmail({ doneCount: 2, total: 6, setupUrl })
    expect(many.subject).toBe("You're 4 shows away from the full network")
    expect(many.html).toContain('Add the rest')
  })

  test('escapes the first name', () => {
    const { html } = renderFeedReminderEmail({
      firstName: 'A<b>d</b>a',
      doneCount: 0,
      total: 3,
      setupUrl,
    })
    expect(html).toContain('Hi A&lt;b&gt;d&lt;/b&gt;a,')
    expect(html).not.toContain('Hi A<b>d</b>a,')
  })
})
