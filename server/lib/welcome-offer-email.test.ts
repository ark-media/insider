// The welcome-offer email states the member's own price and term — the same
// figures /offer quotes — so these pin the wording per cadence.

import { describe, test, expect } from 'bun:test'
import { renderWelcomeOfferEmail } from './welcome-offer-email'

const base = {
  offerPrice: '$20',
  bundlePrice: '$25',
  discountedMonths: 3,
  offerUrl: 'https://ark-plus.xyz/api/auth/email-login?lt=t&to=%2Foffer',
}

describe('renderWelcomeOfferEmail', () => {
  test('quotes a monthly member their months', () => {
    const { html } = renderWelcomeOfferEmail({ ...base, plan: 'monthly' })
    expect(html).toContain('$20 a month for your first 3 months (then $25 a month)')
    expect(html).toContain('31 October 2026')
    expect(html).toContain(base.offerUrl)
  })

  test('quotes an annual member their year', () => {
    const { html } = renderWelcomeOfferEmail({
      ...base,
      plan: 'yearly',
      offerPrice: '$200',
      bundlePrice: '$250',
    })
    expect(html).toContain('$200 for your first year (then $250 a year)')
    expect(html).not.toContain('a month')
  })

  test('greets by name, escaped', () => {
    const { html } = renderWelcomeOfferEmail({ ...base, plan: 'monthly', firstName: 'A<b>' })
    expect(html).toContain('Hi A&lt;b&gt;,')
  })

  test('the claim button carries the member\'s own sign-in link', () => {
    const { html } = renderWelcomeOfferEmail({ ...base, plan: 'monthly' })
    expect(html).toMatch(
      new RegExp(`<a href="${base.offerUrl.replace(/[.?]/g, '\\$&')}"[^>]*>Claim your offer to join the Fold`),
    )
  })

  test('is transactional: no unsubscribe block or postal address', () => {
    const { html } = renderWelcomeOfferEmail({ ...base, plan: 'monthly' })
    expect(html.toLowerCase()).not.toContain('unsubscribe')
    expect(html).not.toContain('RESEND_UNSUBSCRIBE_URL')
    expect(html).not.toContain('Street Address')
  })
})
