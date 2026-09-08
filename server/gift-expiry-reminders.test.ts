// Unit tests for the gift-expiry reminder cron (server/lib/gift-expiry-reminders).
// candidatesForRow is a pure decision function; the orchestrator is exercised
// with a fake sql (routing by query text), an injected email resolver, and an
// injected sender, so no DB / Auth0 / Resend is touched.

import { describe, test, expect, mock } from 'bun:test'

// Importing the module pulls in the Neon driver transitively (membership.js →
// db.js). Stub it so the module loads without a real connection string.
mock.module('@neondatabase/serverless', () => ({
  neon: () => () => Promise.resolve([]),
  __esModule: true,
}))

import {
  candidatesForRow,
  runGiftExpiryReminders,
  GIFT_EXPIRY_REMINDER_DAYS,
} from './lib/gift-expiry-reminders'
import { renderGiftExpiryEmail } from './lib/gift-expiry-email'
import type { GiftExpiryRow } from './lib/membership'

const NOW = 1_700_000_000_000
const inDays = (n: number) => new Date(NOW + n * 86_400_000).toISOString()

function row(over: Partial<GiftExpiryRow>): GiftExpiryRow {
  return {
    auth0_sub: 'auth0|gift',
    tier: 'ark-plus',
    stripe_subscription_id: null,
    ark_plus_gift_expires_at: null,
    circle_gift_expires_at: null,
    ...over,
  }
}

describe('candidatesForRow', () => {
  test('a gift-only Ark+ term inside the window is a candidate', () => {
    const c = candidatesForRow(row({ ark_plus_gift_expires_at: inDays(10) }), 14, NOW)
    expect(c).toHaveLength(1)
    expect(c[0].axis).toBe('ark_plus')
    expect(c[0].axisLabel).toBe('Ark+')
    expect(c[0].otherAxisSubscribed).toBe(false)
  })

  test('a term beyond the window is skipped', () => {
    const c = candidatesForRow(row({ ark_plus_gift_expires_at: inDays(30) }), 14, NOW)
    expect(c).toHaveLength(0)
  })

  test('an already-expired term is skipped (banner/reminder only nudge live access)', () => {
    const c = candidatesForRow(row({ ark_plus_gift_expires_at: inDays(-1) }), 14, NOW)
    expect(c).toHaveLength(0)
  })

  test('a subscription-backed axis is never reminded, even with a stray expiry', () => {
    // ark-plus sub covers the ark_plus axis → the gift column isn't what's ending.
    const c = candidatesForRow(
      row({
        tier: 'ark-plus',
        stripe_subscription_id: 'sub_1',
        ark_plus_gift_expires_at: inDays(5),
      }),
      14,
      NOW,
    )
    expect(c).toHaveLength(0)
  })

  test('a Community gift on an Ark+ subscriber flags the D9 bundle-switch case', () => {
    const c = candidatesForRow(
      row({
        tier: 'ark-plus',
        stripe_subscription_id: 'sub_1',
        circle_gift_expires_at: inDays(7),
      }),
      14,
      NOW,
    )
    expect(c).toHaveLength(1)
    expect(c[0].axis).toBe('circle')
    // The other axis (ark_plus) is subscription-backed → offer the bundle switch.
    expect(c[0].otherAxisSubscribed).toBe(true)
  })

  test('both axes gifted and both in-window → two candidates', () => {
    const c = candidatesForRow(
      row({ tier: 'bundle', ark_plus_gift_expires_at: inDays(3), circle_gift_expires_at: inDays(9) }),
      14,
      NOW,
    )
    expect(c.map((x) => x.axis).sort()).toEqual(['ark_plus', 'circle'])
  })
})

// A fake tagged-template sql that routes by query text: membership select →
// fixed rows; ledger select → membership of a Set; ledger insert → add to Set.
function makeSql(rows: GiftExpiryRow[], sent: Set<string>) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ')
    if (q.includes('from membership')) return Promise.resolve(rows)
    const key = `${values[0]}|${values[1]}|${values[2]}`
    if (q.includes('from gift_expiry_reminder_sends')) {
      return Promise.resolve(sent.has(key) ? [1] : [])
    }
    if (q.includes('insert into gift_expiry_reminder_sends')) {
      sent.add(key)
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
}

describe('runGiftExpiryReminders', () => {
  const baseDeps = () => {
    const sent = new Set<string>()
    const sends: { to: string; subject: string }[] = []
    return {
      sent,
      sends,
      send: async (_env: Record<string, string>, m: { to: string; subject: string; html: string }) => {
        sends.push({ to: m.to, subject: m.subject })
        return true
      },
    }
  }

  test('sends one reminder per eligible axis and records the ledger', async () => {
    const { sent, sends, send } = baseDeps()
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    const summary = await runGiftExpiryReminders({
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => ({ email: 'recipient@example.com', firstName: 'Hannah' }),
      send,
    })
    expect(summary).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 })
    expect(sends).toHaveLength(1)
    expect(sends[0].to).toBe('recipient@example.com')
    expect(sent.has('auth0|a|ark_plus|' + inDays(5))).toBe(true)
  })

  test('the countdown agrees with the dated deadline, and names the zone', async () => {
    // End-to-end through the real formatter: the two halves of the sentence are
    // derived independently (day count vs formatted date), so this is what
    // catches them drifting apart. Host-zone independent — both are pinned to ET.
    const { sent } = baseDeps()
    const captured: { subject: string; html: string }[] = []
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    await runGiftExpiryReminders({
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => ({ email: 'recipient@example.com' }),
      send: async (
        _env: Record<string, string>,
        m: { to: string; subject: string; html: string },
      ) => {
        captured.push({ subject: m.subject, html: m.html })
        return true
      },
    })
    expect(captured[0].subject).toBe('Your gifted access to Ark+ ends in 5 days')
    expect(captured[0].html).toContain(
      'Your gifted access to Ark+ ends in 5 days, on <strong>November 19, 2023 ET</strong>.',
    )
  })

  test('a second run for the same term does not re-send (ledger dedup)', async () => {
    const { sent, sends, send } = baseDeps()
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    const deps = {
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => ({ email: 'recipient@example.com', firstName: 'Hannah' }),
      send,
    }
    await runGiftExpiryReminders(deps)
    const second = await runGiftExpiryReminders(deps)
    expect(second.sent).toBe(0)
    expect(sends).toHaveLength(1)
  })

  test('an unresolvable email counts as failed and leaves the ledger untouched (retryable)', async () => {
    const { sent, sends, send } = baseDeps()
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    const summary = await runGiftExpiryReminders({
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => null,
      send,
    })
    expect(summary.failed).toBe(1)
    expect(summary.sent).toBe(0)
    expect(sends).toHaveLength(0)
    expect(sent.size).toBe(0)
  })

  test('greets the recipient by name — the reminder used to always say "Hi there,"', async () => {
    const { sent } = baseDeps()
    const htmls: string[] = []
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    await runGiftExpiryReminders({
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => ({ email: 'r@example.com', firstName: 'Hannah' }),
      send: async (_env, m) => {
        htmls.push(m.html)
        return true
      },
    })
    expect(htmls[0]).toContain('Hi Hannah,')
  })

  test('falls back to "Hi there," when no real name is held', async () => {
    const { sent } = baseDeps()
    const htmls: string[] = []
    const rows = [row({ auth0_sub: 'auth0|a', ark_plus_gift_expires_at: inDays(5) })]
    await runGiftExpiryReminders({
      env: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sql: makeSql(rows, sent) as any,
      appBaseUrl: 'https://ark.test',
      withinDays: GIFT_EXPIRY_REMINDER_DAYS,
      nowMs: NOW,
      resolveRecipient: async () => ({ email: 'r@example.com' }),
      send: async (_env, m) => {
        htmls.push(m.html)
        return true
      },
    })
    expect(htmls[0]).toContain('Hi there,')
  })
})

describe('renderGiftExpiryEmail', () => {
  test('standalone copy when the recipient has no other subscription', () => {
    const { subject, html } = renderGiftExpiryEmail({
      axisLabel: 'Ark+',
      expiresOn: 'August 20, 2026 ET',
      daysRemaining: 7,
      accountUrl: 'https://ark.test/account',
      otherAxisSubscribed: false,
    })
    expect(subject).toContain('Ark+')
    // The countdown carries the subject; the date lives in the preheader/body so
    // the subject doesn't get truncated in the inbox list.
    expect(subject).toContain('in 7 days')
    expect(html).toContain('August 20, 2026 ET')
    expect(html).toContain('subscribe from')
    expect(html).toContain('https://ark.test/account')
  })

  test('states the countdown and the dated deadline in one sentence', () => {
    const { html } = renderGiftExpiryEmail({
      axisLabel: 'Ark+',
      expiresOn: 'August 20, 2026 ET',
      daysRemaining: 7,
      accountUrl: 'https://ark.test/account',
      otherAxisSubscribed: false,
    })
    expect(html).toContain(
      'Your gifted access to Ark+ ends in 7 days, on <strong>August 20, 2026 ET</strong>.',
    )
  })

  test('reads naturally at the edges of the window', () => {
    const render = (daysRemaining: number) =>
      renderGiftExpiryEmail({
        axisLabel: 'Ark+',
        expiresOn: 'August 20, 2026 ET',
        daysRemaining,
        accountUrl: 'https://ark.test/account',
        otherAxisSubscribed: false,
      })
    expect(render(1).subject).toContain('ends tomorrow')
    expect(render(1).html).toContain('ends tomorrow, on')
    expect(render(0).subject).toContain('ends today')
    // Never "in 0 days" or a negative count if a run straddles the boundary.
    expect(render(-1).subject).toContain('ends today')
    expect(render(2).subject).toContain('in 2 days')
  })

  test('bundle-switch copy when the recipient already subscribes to the other axis', () => {
    const { html } = renderGiftExpiryEmail({
      axisLabel: 'the Fold',
      expiresOn: 'August 20, 2026 ET',
      daysRemaining: 7,
      accountUrl: 'https://ark.test/account',
      otherAxisSubscribed: true,
    })
    expect(html).toContain('bundle')
    expect(html).toContain('ends in 7 days, on')
  })
})
