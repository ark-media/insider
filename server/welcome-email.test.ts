import { describe, test, expect } from 'bun:test'
import {
  renderGiftRedemptionEmail,
  renderGiftWelcomeEmail,
  renderSubscriberWelcomeEmail,
} from './lib/welcome-email'

describe('renderGiftRedemptionEmail', () => {
  test('single magic link: one CTA points at the claim link, no set-password step', () => {
    // The whole recipient flow is one magic link — no separate sign-in or
    // set-password link, and no Auth0 provisioning at purchase, so exactly one
    // email reaches the recipient.
    const { subject, html } = renderGiftRedemptionEmail({
      recipientName: 'Alice',
      giverName: 'Bob',
      term: '1yr',
      claimUrl: 'https://app.test/redeem?mt=jwt.abc.def',
    })
    expect(subject).toContain('Bob')
    expect(html).toContain('Start your membership')
    expect(html).toContain('https://app.test/redeem?mt=jwt.abc.def')
    expect(html).not.toContain('Set your password')
    // Auto-login promise, not a "sign in first" instruction.
    expect(html).toContain('signed in automatically')
  })
})

describe('renderGiftWelcomeEmail', () => {
  test('new account: set-password CTA carries the ticket URL', () => {
    const { subject, html } = renderGiftWelcomeEmail({
      recipientName: 'Alice Smith',
      giverName: 'Bob',
      term: '1yr',
      message: 'Enjoy the show',
      welcomeUrl: 'https://app.test/welcome',
      passwordSetupUrl: 'https://auth.test/u/reset?ticket=abc',
    })
    expect(subject).toBe('Bob sent you Ark+')
    expect(html).toContain('Bob gifted you 1 year of Ark+.')
    expect(html).toContain('Hi Alice,') // first name only
    expect(html).toContain('Set your password')
    expect(html).toContain('https://auth.test/u/reset?ticket=abc')
    expect(html).toContain('Enjoy the show')
    // Welcome page still referenced as the follow-up step.
    expect(html).toContain('https://app.test/welcome')
  })

  test('an address typed into recipient_name is never greeted', () => {
    // Free text a giver types. The capitalization rule used to accept this,
    // rendering "Hi Alice@example.com," at the top of the welcome email.
    const { html } = renderGiftWelcomeEmail({
      recipientName: 'Alice@example.com',
      term: '1yr',
      welcomeUrl: 'https://app.test/welcome',
    })
    expect(html).toContain('Hi there,')
    expect(html).not.toContain('Alice@example.com')
  })

  test('existing account: log-in CTA, no ticket', () => {
    const { subject, html } = renderGiftWelcomeEmail({
      giverName: 'Bob',
      term: '6mo',
      welcomeUrl: 'https://app.test/welcome',
    })
    expect(subject).toBe('Bob sent you Ark+')
    expect(html).toContain('6 months of Ark+.')
    expect(html).toContain('Start listening')
    expect(html).toContain('already have an Ark+ login')
    expect(html).not.toContain('Set your password')
  })

  test('no giver name: falls back to generic subject + headline', () => {
    const { subject, html } = renderGiftWelcomeEmail({
      term: '1yr',
      welcomeUrl: 'https://app.test/welcome',
    })
    expect(subject).toBe("You've been gifted Ark+")
    expect(html).toContain("You've been gifted 1 year of Ark+.")
    expect(html).toContain('Hi there,')
  })

  test('escapes HTML in user-supplied giver name and message', () => {
    const { html } = renderGiftWelcomeEmail({
      giverName: '<script>x</script>',
      term: '1yr',
      message: 'a & b < c',
      welcomeUrl: 'https://app.test/welcome',
    })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b &lt; c')
  })
})

describe('renderSubscriberWelcomeEmail', () => {
  test('new account: set-password CTA carries the ticket URL', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      name: 'Casey Jones',
      welcomeUrl: 'https://app.test/welcome',
      passwordSetupUrl: 'https://auth.test/u/reset?ticket=xyz',
      tier: 'ark-plus',
    })
    expect(subject).toBe('Welcome to Ark+')
    expect(html).toContain('Welcome to Ark+.')
    expect(html).toContain('Hi Casey,') // first name only
    expect(html).toContain('Set your password')
    expect(html).toContain('https://auth.test/u/reset?ticket=xyz')
    expect(html).toContain('https://app.test/welcome')
  })

  test('a name manufactured from the address falls back to "Hi there,"', () => {
    // The migrated roster is full of these, and without the email passed
    // alongside there is nothing to compare the name against — so it renders.
    const { html } = renderSubscriberWelcomeEmail({
      name: 'hannah.waxman8',
      email: 'hannah.waxman8@gmail.com',
      welcomeUrl: 'https://app.test/welcome',
      tier: 'ark-plus',
    })
    expect(html).toContain('Hi there,')
    expect(html).not.toContain('hannah.waxman8')
  })

  test('existing account: log-in CTA, no ticket', () => {
    const { html } = renderSubscriberWelcomeEmail({
      welcomeUrl: 'https://app.test/welcome',
      tier: 'ark-plus',
    })
    expect(html).toContain('Start listening')
    expect(html).toContain('already have an Ark+ login')
    expect(html).not.toContain('Set your password')
    expect(html).toContain('Hi there,')
  })

  test('ark-plus (feed-only): does not promise the community', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      welcomeUrl: 'https://app.test/welcome',
      tier: 'ark-plus',
    })
    expect(subject).toBe('Welcome to Ark+')
    expect(html).toContain('Welcome to Ark+.')
    expect(html).toContain('private feed')
    // A feed-only membership must not advertise community access it lacks.
    expect(html).not.toContain('community')
  })

  test('bundle: adds the community on top of the feed', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      welcomeUrl: 'https://app.test/welcome',
      tier: 'bundle',
    })
    expect(subject).toBe('Welcome to Ark+ Bundle')
    expect(html).toContain('Welcome to Ark+ Bundle.')
    expect(html).toContain('private feed')
    expect(html).toContain('community')
  })
})
