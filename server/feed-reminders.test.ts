// Unit tests for the feed-setup reminder decision logic and email rendering.
// The pure functions (memberInWindow / evaluateReminder / loadReminderConfigFromEnv)
// carry the rules, so they're tested here without the DB or Resend. The cron
// route's auth + wiring is covered in feed-reminders-cron.test.ts.

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_REMINDER_CONFIG,
  evaluateReminder,
  loadReminderConfigFromEnv,
  memberInWindow,
  memberStatusEligible,
  passesCheapGate,
  type PremiumReader,
} from './lib/feed-reminders'
import { renderFeedReminderEmail } from './lib/feed-reminder-email'

const NOW = Date.parse('2026-07-16T12:00:00Z')
const HOUR = 3_600_000
const DAY = 86_400_000

// The one premium show every reminder is about.
const SHOW = 'pod_show'

function member(over: Partial<PremiumReader> = {}): PremiumReader {
  return {
    email: 'a@x.com',
    firstName: 'Ada',
    status: 'active',
    joined: new Date(NOW - 3 * DAY).toISOString(),
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

  test('unsubscribed / inactive / invalid (any case) are skipped', () => {
    expect(memberStatusEligible('unsubscribed')).toBe(false)
    expect(memberStatusEligible('Inactive')).toBe(false)
    expect(memberStatusEligible('INVALID')).toBe(false)
    expect(memberStatusEligible('needs_attention')).toBe(false)
  })
})

// ===========================================================================
// passesCheapGate
// ===========================================================================

describe('passesCheapGate', () => {
  // DEFAULT is enabled:false (opt-in); these cases test the other gates, so
  // start from an enabled config.
  const cfg = { ...DEFAULT_REMINDER_CONFIG, enabled: true }

  test('active in-window member passes', () => {
    expect(passesCheapGate(member(), cfg, NOW)).toBe(true)
  })

  test('member with no email is gated out', () => {
    expect(passesCheapGate(member({ email: '  ' }), cfg, NOW)).toBe(false)
  })

  test('unsubscribed member is gated out', () => {
    expect(passesCheapGate(member({ status: 'unsubscribed' }), cfg, NOW)).toBe(false)
  })

  test('disabled config gates everyone out', () => {
    expect(passesCheapGate(member(), { ...cfg, enabled: false }, NOW)).toBe(false)
  })
})

// ===========================================================================
// evaluateReminder
// ===========================================================================

describe('evaluateReminder', () => {
  // enabled:true (DEFAULT is opt-in off).
  const cfg = { ...DEFAULT_REMINDER_CONFIG, enabled: true }

  test('feed not set up → candidate with doneCount 0', () => {
    const c = evaluateReminder(member(), new Set(), false, cfg, NOW, SHOW)
    expect(c).not.toBeNull()
    expect(c).toMatchObject({
      email: 'a@x.com',
      firstName: 'Ada',
      doneCount: 0,
      total: 1,
    })
  })

  test('feed set up → null (nothing to nudge)', () => {
    const c = evaluateReminder(member(), new Set([SHOW]), false, cfg, NOW, SHOW)
    expect(c).toBeNull()
  })

  test('a different show being set up does not count', () => {
    // Activation is keyed per show; another show's row must never suppress
    // this show's reminder.
    const c = evaluateReminder(member(), new Set(['pod_other']), false, cfg, NOW, SHOW)
    expect(c).toMatchObject({ doneCount: 0, total: 1 })
  })

  test('already sent → null', () => {
    const c = evaluateReminder(member(), new Set(), true, cfg, NOW, SHOW)
    expect(c).toBeNull()
  })

  test('out of window → null even with zero setup', () => {
    const old = member({ joined: new Date(NOW - 30 * DAY).toISOString() })
    expect(evaluateReminder(old, new Set(), false, cfg, NOW, SHOW)).toBeNull()
  })

  test('normalizes email (trims + lowercases)', () => {
    const c = evaluateReminder(
      member({ email: '  Ada@X.COM  ' }),
      new Set(),
      false,
      cfg,
      NOW,
      SHOW,
    )
    expect(c?.email).toBe('ada@x.com')
  })

  test('blank first name yields undefined (email falls back to "Hi there")', () => {
    const c = evaluateReminder(member({ firstName: '   ' }), new Set(), false, cfg, NOW, SHOW)
    expect(c?.firstName).toBeUndefined()
  })

  test('a whole name in firstName greets by the leading token only', () => {
    const c = evaluateReminder(
      member({ firstName: 'Ada Lovelace' }),
      new Set(),
      false,
      cfg,
      NOW,
      SHOW,
    )
    expect(c?.firstName).toBe('Ada')
  })

  test('a name manufactured from the email local part is never greeted', () => {
    // The guard that stops "Hi hannah.waxman8," reaching a real inbox.
    const c = evaluateReminder(
      member({ email: 'ada.lovelace@x.com', firstName: 'ada.lovelace' }),
      new Set(),
      false,
      cfg,
      NOW,
      SHOW,
    )
    expect(c?.firstName).toBeUndefined()
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
