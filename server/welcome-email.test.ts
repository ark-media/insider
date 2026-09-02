import { describe, test, expect } from 'bun:test'
import {
  FEED_INCLUDED,
  renderAxisAddedEmail,
  renderGiftRedemptionEmail,
  renderGiftWelcomeEmail,
  renderSubscriberWelcomeEmail,
} from './lib/welcome-email'
import { circleUrls } from '../src/config/urls'

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
    // The feed blurb, asserted through the constant rather than a copy literal:
    // what matters is that this tier gets the feed benefits and stops there.
    expect(html).toContain(FEED_INCLUDED)
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
    // Same feed blurb as ark-plus, with the community appended — the two
    // assertions together are what "on top of the feed" means.
    expect(html).toContain(FEED_INCLUDED)
    expect(html).toContain('community')
  })
})

describe('renderAxisAddedEmail', () => {
  test('states the new price as the whole cost, and that nothing is due today', () => {
    // The two things this email exists to say. "Covers everything" is what
    // defuses the fear the price is charged ON TOP of the old one, and
    // "nothing to pay today" is the answer to the question a member actually
    // has — the change is settled on the next bill, so their card shows
    // nothing and no one guesses why.
    const { subject, html } = renderAxisAddedEmail({
      name: 'Alice Smith',
      email: 'alice@example.com',
      axis: 'circle',
      welcomeUrl: 'https://app.test/welcome',
      price: '$25',
      plan: 'monthly',
      renewsOn: 'September 14, 2026',
    })
    expect(subject).toContain('community')
    expect(html).toContain('Hi Alice,')
    expect(html).toContain('$25 a month')
    expect(html).toContain('covers everything')
    expect(html).toContain('Nothing to pay today')
    expect(html).toContain('September 14, 2026')
    expect(html).toContain('Enter the community')
    // Not a first-purchase welcome, and never a set-password email: this member
    // has had a login since the day they first subscribed.
    expect(html).not.toContain('Welcome to Ark+')
    expect(html).not.toContain('Set your password')
  })

  test('speaks in bills and months, never in our billing vocabulary', () => {
    // The words this copy was workshopped OUT of. Members have bills and
    // months; "prorated", "invoice" and "billing period" are our machinery,
    // and they read as a company talking to itself.
    const { html } = renderAxisAddedEmail({
      axis: 'circle',
      welcomeUrl: 'https://app.test/welcome',
      price: '$25',
      plan: 'monthly',
      renewsOn: 'September 14, 2026',
    })
    for (const jargon of ['prorat', 'invoice', 'billing period', 'subscription']) {
      expect(html.toLowerCase()).not.toContain(jargon)
    }
  })

  test('yearly cadence is stated as a year, not a month', () => {
    const { html } = renderAxisAddedEmail({
      axis: 'circle',
      welcomeUrl: 'https://app.test/welcome',
      price: '$250',
      plan: 'yearly',
    })
    expect(html).toContain('$250 a year')
    expect(html).toContain('the rest of this year')
    expect(html).not.toContain('a month')
  })

  test('an unreadable price drops the figure rather than guessing one', () => {
    // The price is omitted when it can't be read in the currency the member is
    // actually charged in. The email still has to say what their membership
    // covers, and still owes them the "nothing today" answer.
    const { html } = renderAxisAddedEmail({
      axis: 'circle',
      welcomeUrl: 'https://app.test/welcome',
      plan: 'monthly',
    })
    expect(html).toContain('covers everything')
    expect(html).toContain('Nothing to pay today')
    expect(html).not.toContain('$')
    // No date given → no promise about which day the bill lands.
    expect(html).not.toContain('Your next bill is')
  })

  test('adding Community: carries the app links and the profile setup link', () => {
    // A new community member meets the download step on /welcome. Someone who
    // upgrades from their account page never passes through it, so the links
    // have to travel in the email itself — getting the app IS the step that
    // puts them in the community, and the profile is what makes them a person
    // in it rather than an email address.
    const { html } = renderAxisAddedEmail({
      axis: 'circle',
      welcomeUrl: 'https://app.test/welcome',
      price: '$25',
      plan: 'monthly',
    })
    expect(html).toContain(circleUrls.appStoreIos)
    expect(html).toContain(circleUrls.appStoreAndroid)
    expect(html).toContain(circleUrls.webApp)
    expect(html).toContain(circleUrls.profileSettings)
    // Text links, not the store badge lockups: SVG doesn't render in most mail
    // clients, and image blocking would leave the row empty in the rest.
    expect(html).not.toContain('<img')
  })

  test('adding Ark+: feed copy and the feed setup CTA', () => {
    const { subject, html } = renderAxisAddedEmail({
      axis: 'ark-plus',
      welcomeUrl: 'https://app.test/welcome',
      price: '$25',
      plan: 'monthly',
    })
    expect(subject).toContain('feed')
    expect(html).toContain(FEED_INCLUDED)
    expect(html).toContain('Set up your feed')
    expect(html).not.toContain('Enter the community')
    // The community app links belong to the axis that grants the community.
    expect(html).not.toContain(circleUrls.appStoreIos)
  })
})
