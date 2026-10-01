// The welcome-offer email quotes both cadences in the member's own currency —
// the same figures /offer quotes — so these pin the wording.

import { describe, test, expect } from 'bun:test'
import { renderWelcomeOfferEmail } from './welcome-offer-email'

const base = {
  monthly: { offerPrice: '$20', bundlePrice: '$25' },
  yearly: { offerPrice: '$200', bundlePrice: '$250' },
  discountedMonths: 3,
  offerUrl: 'https://ark-plus.xyz/api/auth/email-login?lt=t&to=%2Foffer',
  openHouseUrl: 'https://ark-plus.xyz/fold?utm_source=ark-plus',
}

describe('renderWelcomeOfferEmail', () => {
  test('quotes both cadences, offer then list price', () => {
    const { html } = renderWelcomeOfferEmail(base)
    expect(html).toContain('$20/month')
    expect(html).toContain('for your first 3 months')
    expect(html).toContain('Then $25/month.')
    expect(html).toContain('$200/year')
    expect(html).toContain('Then $250/year.')
    expect(html).toContain('OFFER ENDS OCTOBER 31, 2026')
  })

  test('escapes the formatted prices', () => {
    const { html } = renderWelcomeOfferEmail({
      ...base,
      monthly: { offerPrice: '<b>', bundlePrice: '$25' },
    })
    expect(html).toContain('&lt;b&gt;/month')
  })

  test("the upgrade button carries the member's own sign-in link", () => {
    const { html } = renderWelcomeOfferEmail(base)
    expect(html).toMatch(
      new RegExp(`<a href="${base.offerUrl.replace(/[.?]/g, '\\$&')}"[^>]*><strong[^>]*>UPGRADE MY MEMBERSHIP`),
    )
    expect(html).toContain(`href="${base.openHouseUrl}"`)
  })

  test('is transactional: no unsubscribe block or postal address', () => {
    const { html } = renderWelcomeOfferEmail(base)
    expect(html.toLowerCase()).not.toContain('unsubscribe')
    expect(html).not.toContain('RESEND_UNSUBSCRIBE_URL')
    expect(html).not.toContain('Street Address')
  })
})
