// Unit tests for the annual renewal reminder cron (server/lib/renewal-reminders)
// and the three billing-notice renderers. The orchestrator runs against a fake
// sql (routing by query text) and injected quote / recipient / send functions,
// so no DB, Stripe, Auth0 or Resend is touched.

import { describe, test, expect, mock } from 'bun:test'

// membership.js → db.js pulls in the Neon driver; stub it so the module loads.
mock.module('@neondatabase/serverless', () => ({
  neon: () => () => Promise.resolve([]),
  __esModule: true,
}))

import {
  isReminderCandidate,
  runRenewalReminders,
  RENEWAL_REMINDER_DAYS,
} from './lib/renewal-reminders'
import {
  renderAccessEndedEmail,
  renderCardUpdatedEmail,
  renderRenewalReminderEmail,
} from './lib/billing-notice-emails'
import { getAnnualRenewalsWithin, type AnnualRenewalRow } from './lib/membership'

// 2030-01-01T00:00:00Z: renders as December 31, 2029 in ET.
const PERIOD_END = '2030-01-01T00:00:00.000Z'

function row(over: Partial<AnnualRenewalRow> = {}): AnnualRenewalRow {
  return {
    auth0_sub: 'auth0|member',
    stripe_subscription_id: 'sub_1',
    tier: 'ark-plus',
    scheduled_tier: null,
    pending_plan: null,
    current_period_end: PERIOD_END,
    ...over,
  }
}

function makeSql(rows: AnnualRenewalRow[], sent: Set<string>) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ')
    if (q.includes('from membership')) return Promise.resolve(rows)
    const key = `${values[0]}|${values[1]}`
    if (q.includes('from renewal_reminder_sends')) {
      return Promise.resolve(sent.has(key) ? [1] : [])
    }
    if (q.includes('insert into renewal_reminder_sends')) {
      sent.add(key)
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
}

function deps(rows: AnnualRenewalRow[], over: Record<string, unknown> = {}) {
  const sent = new Set<string>()
  const sends: { to: string; subject: string; html: string; idempotencyKey?: string }[] = []
  return {
    sent,
    sends,
    run: {
      env: {},
      sql: makeSql(rows, sent) as never,
      appBaseUrl: 'https://app.test',
      withinDays: RENEWAL_REMINDER_DAYS,
      quoteRenewal: async () => ({ amountMinor: 8000, currency: 'usd' }),
      resolveRecipient: async () => ({ email: 'member@example.com', firstName: 'Dana' }),
      send: async (_env: Record<string, string>, m: (typeof sends)[number]) => {
        sends.push(m)
        return true
      },
      ...over,
    },
  }
}

describe('isReminderCandidate', () => {
  test('a plain annual renewal is reminded', () => {
    expect(isReminderCandidate(row())).toBe(true)
  })

  test('a booked switch to monthly is not an annual renewal', () => {
    expect(isReminderCandidate(row({ pending_plan: 'monthly' }))).toBe(false)
  })

  test('a booked debundle still renews yearly, as the product kept', () => {
    expect(isReminderCandidate(row({ tier: 'bundle', scheduled_tier: 'circle', pending_plan: 'yearly' }))).toBe(true)
  })
})

describe('runRenewalReminders', () => {
  test('sends the date, the quoted amount and the cancel route, then records the ledger', async () => {
    const d = deps([row()])
    const summary = await runRenewalReminders(d.run)
    expect(summary).toEqual({ scanned: 1, eligible: 1, sent: 1, failed: 0 })
    expect(d.sends).toHaveLength(1)
    const m = d.sends[0]
    expect(m.to).toBe('member@example.com')
    expect(m.subject).toBe('Your Ark+ membership renews on December 31, 2029 ET')
    expect(m.html).toContain('$80')
    expect(m.html).toContain('cancel from')
    expect(m.html).toContain('https://app.test/account/billing')
    expect(m.idempotencyKey).toBe(`renewal_reminder_sub_1_${PERIOD_END}`)
    expect(d.sent.has(`sub_1|${PERIOD_END}`)).toBe(true)
  })

  test('a renewal already reminded is skipped without a quote or lookup', async () => {
    let quoted = 0
    const d = deps([row()], {
      quoteRenewal: async () => {
        quoted++
        return { amountMinor: 8000, currency: 'usd' }
      },
    })
    await runRenewalReminders(d.run)
    const second = await runRenewalReminders(d.run)
    expect(second.eligible).toBe(0)
    expect(quoted).toBe(1)
    expect(d.sends).toHaveLength(1)
  })

  test('no quote → no email and no ledger row, so tomorrow retries', async () => {
    const d = deps([row()], { quoteRenewal: async () => null })
    const summary = await runRenewalReminders(d.run)
    expect(summary.failed).toBe(1)
    expect(d.sends).toHaveLength(0)
    expect(d.sent.size).toBe(0)
  })

  test('no recipient address → no email and no ledger row', async () => {
    const d = deps([row()], { resolveRecipient: async () => ({ email: null }) })
    await runRenewalReminders(d.run)
    expect(d.sends).toHaveLength(0)
    expect(d.sent.size).toBe(0)
  })

  test('a failed send leaves the ledger untouched', async () => {
    const d = deps([row()], { send: async () => false })
    const summary = await runRenewalReminders(d.run)
    expect(summary.failed).toBe(1)
    expect(d.sent.size).toBe(0)
  })

  test('a booked debundle is named as the product that renews', async () => {
    const d = deps([row({ tier: 'bundle', scheduled_tier: 'circle', pending_plan: 'yearly' })])
    await runRenewalReminders(d.run)
    expect(d.sends[0].subject).toContain('Your Fold membership renews')
  })
})

describe('renderAccessEndedEmail', () => {
  test('a lapsed payment says why it ended', () => {
    const { subject, html } = renderAccessEndedEmail({
      tier: 'ark-plus',
      reason: 'payment_failed',
      rejoinUrl: 'https://app.test/subscribe',
    })
    expect(subject).toBe('Your Ark+ membership has ended')
    expect(html).toContain('take payment after several tries')
    expect(html).toContain('https://app.test/subscribe')
  })

  test('a scheduled end reads as a plain end, and a Fold end says only the Fold', () => {
    const { subject, html } = renderAccessEndedEmail({
      tier: 'circle',
      reason: 'ended',
      rejoinUrl: 'https://app.test/fold',
    })
    expect(subject).toBe('Your Fold membership has ended')
    expect(html).not.toContain('payment')
    expect(html).not.toContain('ad-supported')
  })
})

describe('renderCardUpdatedEmail', () => {
  test('names the new card and says what to do if it was not them', () => {
    const { subject, html } = renderCardUpdatedEmail({
      firstName: 'Dana',
      brand: 'Visa',
      last4: '4242',
      accountUrl: 'https://app.test/account/billing',
    })
    expect(subject).toBe('Your payment card was updated')
    expect(html).toContain('Visa ending in 4242')
    expect(html).toContain('didn&rsquo;t make this change')
  })

  test('a method with no card details still reads', () => {
    const { html } = renderCardUpdatedEmail({
      brand: null,
      last4: null,
      accountUrl: 'https://app.test/account/billing',
    })
    expect(html).toContain('The payment method on your membership was updated.')
  })
})

describe('renderRenewalReminderEmail', () => {
  test('names the tier and the amount', () => {
    const { subject, html } = renderRenewalReminderEmail({
      tier: 'bundle',
      renewsOn: 'March 3, 2027 ET',
      amount: '$250',
      accountUrl: 'https://app.test/account/billing',
    })
    expect(subject).toBe('Your Ark+ and Fold membership renews on March 3, 2027 ET')
    expect(html).toContain('<strong>$250</strong>')
  })
})

// R6 — the roster query behind the reminder: yearly only, nothing booked to
// stop it, and a (now, now + N days] window with N bound as a parameter.
describe('getAnnualRenewalsWithin — R6 query shape', () => {
  function capture() {
    const calls: { sql: string; values: unknown[] }[] = []
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?').replace(/\s+/g, ' '), values })
      return Promise.resolve([])
    }) as never
    return { calls, sql }
  }

  test("R6: filters plan = 'yearly' and a 30-day window from now", async () => {
    const { calls, sql } = capture()
    await getAnnualRenewalsWithin(sql, RENEWAL_REMINDER_DAYS)
    expect(RENEWAL_REMINDER_DAYS).toBe(30)
    expect(calls).toHaveLength(1)
    const q = calls[0].sql
    expect(q).toContain('from membership')
    expect(q).toContain("plan = 'yearly'")
    expect(q).toContain('stripe_subscription_id is not null')
    expect(q).toContain("status in ('active', 'trialing')")
    expect(q).toContain('cancel_at is null')
    expect(q).toContain('current_period_end > now()')
    expect(q).toContain('current_period_end <= now() + make_interval(days => ?)')
    expect(calls[0].values).toEqual([30])
  })

  test('R6: the window length is the bound parameter, not baked in', async () => {
    const { calls, sql } = capture()
    await getAnnualRenewalsWithin(sql, 7)
    expect(calls[0].values).toEqual([7])
  })
})
