// Renderer tests for the four lifecycle emails added alongside the welcome
// family: the three cancellation confirmations, the debundle notice, the
// failed-payment notice, and the 180-day win-back.
//
// These are pure functions, so the assertions are about copy that carries a
// promise — the date access ends, which product stops, what it now costs — and
// about the placeholders in the source doc never reaching a member.

import { describe, test, expect } from 'bun:test'
import {
  TIER_EMAIL_LABEL,
  renderCancellationEmail,
  renderDebundleEmail,
  type CancellableTier,
} from './lib/cancellation-email'
import { renderPaymentFailedEmail } from './lib/payment-failed-email'
import { renderWinbackEmail } from './lib/winback-email'
import { SUPPORT_EMAIL } from './lib/welcome-email'
import { shows } from '../src/data/shows'

const CANCEL_BASE = {
  accessUntil: 'October 14, 2026 ET',
  feedbackUrl: 'https://app.test/contact?topic=general',
  accountUrl: 'https://app.test/account/billing',
}

const TIERS: CancellableTier[] = ['ark-plus', 'circle', 'bundle']

describe('renderCancellationEmail', () => {
  test('subject and headline name the tier that was cancelled', () => {
    expect(renderCancellationEmail({ ...CANCEL_BASE, tier: 'ark-plus' }).subject).toBe(
      'Your Ark+ subscription has been canceled',
    )
    // "Your The Fold membership" is not a sentence — these labels are the
    // possessive form, matching the copy doc.
    expect(renderCancellationEmail({ ...CANCEL_BASE, tier: 'circle' }).subject).toBe(
      'Your Fold membership has been canceled',
    )
    expect(renderCancellationEmail({ ...CANCEL_BASE, tier: 'bundle' }).subject).toBe(
      'Your Ark+ and Fold membership has been canceled',
    )
  })

  test('every variant states the date access actually ends', () => {
    // The single most load-bearing fact in this email: they have not lost
    // anything yet. A cancellation notice that omits the date reads as "gone".
    for (const tier of TIERS) {
      const { html } = renderCancellationEmail({ ...CANCEL_BASE, tier })
      expect(html).toContain('October 14, 2026 ET')
      expect(html).toContain('won&rsquo;t be charged again')
    }
  })

  test('no readable period end → says so in words rather than inventing a date', () => {
    for (const tier of TIERS) {
      const { html } = renderCancellationEmail({
        ...CANCEL_BASE,
        tier,
        accessUntil: null,
      })
      expect(html).toContain('the end of your current billing period')
      expect(html).not.toContain('undefined')
      expect(html).not.toContain('null')
    }
  })

  test('each tier is told what it specifically loses, and nothing it does not', () => {
    const arkPlus = renderCancellationEmail({ ...CANCEL_BASE, tier: 'ark-plus' }).html
    expect(arkPlus).toContain('free, ad-supported version')
    // An Ark+ canceller never had the Fold — do not describe losing it.
    expect(arkPlus).not.toContain('no more logging in')

    const fold = renderCancellationEmail({ ...CANCEL_BASE, tier: 'circle' }).html
    expect(fold).toContain('lose access to The Fold')
    // A Fold member had no feed, so no ad-free-listening eulogy.
    expect(fold).not.toContain('ad-free listening')

    const bundle = renderCancellationEmail({ ...CANCEL_BASE, tier: 'bundle' }).html
    expect(bundle).toContain('free, ad-supported version')
    expect(bundle).toContain('no more logging in')
  })

  test('carries the feedback CTA and a working undo route', () => {
    // The undo is not in the copy doc and is the most useful line here: the
    // cancel is scheduled, not done, so a mis-click is still reversible — and
    // this email is the only place someone would find that out.
    const { html } = renderCancellationEmail({ ...CANCEL_BASE, tier: 'ark-plus' })
    expect(html).toContain(CANCEL_BASE.feedbackUrl)
    expect(html).toContain('Tell us why')
    expect(html).toContain(CANCEL_BASE.accountUrl)
    expect(html).toContain('Changed your mind?')
    expect(html).not.toContain('PLACEHOLDER')
  })

  test('greets by first name when one is known, and never by an address', () => {
    expect(
      renderCancellationEmail({ ...CANCEL_BASE, tier: 'ark-plus', firstName: 'Ada' }).html,
    ).toContain('Hi Ada,')
    expect(renderCancellationEmail({ ...CANCEL_BASE, tier: 'ark-plus' }).html).toContain(
      'Hi there,',
    )
  })

  test('escapes a first name', () => {
    const { html } = renderCancellationEmail({
      ...CANCEL_BASE,
      tier: 'ark-plus',
      firstName: 'A<b>d</b>a',
    })
    expect(html).not.toContain('<b>d</b>')
    expect(html).toContain('&lt;b&gt;')
  })
})

describe('renderDebundleEmail', () => {
  const BASE = {
    effectiveOn: 'October 14, 2026 ET',
    plan: 'monthly' as const,
    accountUrl: 'https://app.test/account/billing',
  }

  test('names what was removed, what is kept, and when it lands', () => {
    const { subject, html } = renderDebundleEmail({
      ...BASE,
      removed: 'circle',
      price: '$8',
    })
    expect(subject).toBe("You've removed The Fold from your membership")
    expect(html).toContain('October 14, 2026 ET')
    expect(html).toContain('$8 a month')
    // What continues has to be as loud as what stops, or this reads as a cancel.
    expect(html).toContain('Ark+')
    expect(html).toContain('lose access to the Fold')
  })

  test('the other direction keeps the Fold and drops the feed', () => {
    const { subject, html } = renderDebundleEmail({
      ...BASE,
      removed: 'ark-plus',
      price: '$10',
    })
    expect(subject).toBe("You've removed Ark+ from your membership")
    expect(html).toContain('free, ad-supported version')
    expect(html).toContain('your place in the Fold carries on')
  })

  test('an unreadable price drops the figure rather than guessing one', () => {
    const { html } = renderDebundleEmail({ ...BASE, removed: 'circle' })
    expect(html).toContain('covers Ark+ alone')
    expect(html).not.toContain('$')
  })

  test('an immediate change says so instead of naming a date', () => {
    const { html } = renderDebundleEmail({
      ...BASE,
      removed: 'circle',
      effectiveOn: null,
    })
    expect(html).toContain('the end of your current billing period')
    expect(html).not.toContain('undefined')
  })

  test('yearly cadence is quoted as a year', () => {
    const { html } = renderDebundleEmail({
      ...BASE,
      removed: 'circle',
      plan: 'yearly',
      price: '$80',
    })
    expect(html).toContain('$80 a year')
    expect(html).not.toContain('a month')
  })
})

describe('renderPaymentFailedEmail', () => {
  const UPDATE_URL = 'https://app.test/account/billing'

  test('names the product and points at the card-update page', () => {
    const { subject, html } = renderPaymentFailedEmail({
      firstName: 'Ada',
      tier: 'bundle',
      updateCardUrl: UPDATE_URL,
    })
    expect(subject).toBe("We couldn't process your payment")
    expect(html).toContain('Hi Ada,')
    expect(html).toContain(`your ${TIER_EMAIL_LABEL.bundle} membership`)
    expect(html).toContain(UPDATE_URL)
    expect(html).toContain('Update payment method')
    expect(html).toContain(SUPPORT_EMAIL)
  })

  test('an unknown tier degrades to "your membership", never a wrong product', () => {
    // The tier comes from the membership row, which a DB-less env doesn't have.
    // Naming the wrong product to someone whose card just failed is worse than
    // naming none.
    const { html } = renderPaymentFailedEmail({ tier: null, updateCardUrl: UPDATE_URL })
    expect(html).toContain('for your membership')
    for (const label of Object.values(TIER_EMAIL_LABEL)) {
      expect(html).not.toContain(`your ${label} membership`)
    }
  })

  test('says access is still live — the point is that there is time to fix it', () => {
    const { html } = renderPaymentFailedEmail({ tier: 'ark-plus', updateCardUrl: UPDATE_URL })
    expect(html).toContain('still active for now')
    expect(html).toContain('rarely anything serious')
  })
})

describe('renderWinbackEmail', () => {
  const BASE = {
    rejoinUrl: 'https://app.test/plus',
    unsubscribeUrl: 'https://app.test/api/winback/unsubscribe?e=abc&t=xyz',
  }

  test('carries the rejoin CTA and the four member benefits', () => {
    const { subject, html } = renderWinbackEmail({ firstName: 'Ada', ...BASE })
    expect(subject).toBe('We saved your seat')
    expect(html).toContain('Hi Ada,')
    expect(html).toContain(BASE.rejoinUrl)
    expect(html).toContain('Rejoin Ark+')
    expect(html).toContain('Dan Senor')
    expect(html).toContain('two days before they go public')
    expect(html).toContain('Ad-free listening across every Ark Media show')
  })

  test('names the members-only show as the app names it', () => {
    // The copy doc says "Inside Call Me Back", which is what the show used to be
    // called. Reading the title off the show data is what keeps this bullet from
    // promising a product name that no longer exists.
    const premium = shows.find((s) => s.paid)!
    const { html } = renderWinbackEmail(BASE)
    expect(html).toContain(premium.title)
  })

  test('carries a working unsubscribe — this is the one send to a non-customer', () => {
    const { html } = renderWinbackEmail(BASE)
    expect(html).toContain(BASE.unsubscribeUrl)
    expect(html).toContain('Unsubscribe')
  })
})
