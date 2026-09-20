import { describe, test, expect } from 'bun:test'
import {
  ARK_PLUS_EXTRAS,
  FEED_INCLUDED,
  SUPPORT_EMAIL,
  networkShowBullets,
  renderAxisAddedEmail,
  renderCircleWelcomeEmail,
  renderGiftRedemptionEmail,
  renderSubscriberWelcomeEmail,
} from './lib/welcome-email'
import { circleUrls } from '../src/config/urls'
import { shows } from '../src/data/shows'

const URLS = {
  welcomeUrl: 'https://app.test/welcome',
  setupUrl: 'https://app.test/setup',
}

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
    expect(html).not.toMatch(/password/i)
    // Auto-login promise, not a "sign in first" instruction.
    expect(html).toContain('signed in automatically')
  })

  test('an address typed into recipient_name is never greeted', () => {
    // Free text a giver types. An address in this field is never a name.
    const { html } = renderGiftRedemptionEmail({
      recipientName: 'Alice@example.com',
      term: '1yr',
      claimUrl: 'https://app.test/redeem?mt=jwt',
    })
    expect(html).toContain('Hi there,')
    expect(html).not.toContain('Alice@example.com')
  })

  test('no giver name: falls back to generic subject + headline', () => {
    const { subject, html } = renderGiftRedemptionEmail({
      term: '1yr',
      claimUrl: 'https://app.test/redeem?mt=jwt',
    })
    expect(subject).toBe("You've been gifted Ark+")
    expect(html).toContain("You've been gifted 1 year of Ark+.")
    expect(html).toContain('Hi there,')
  })

  test('escapes HTML in user-supplied giver name and message', () => {
    const { html } = renderGiftRedemptionEmail({
      giverName: '<script>x</script>',
      term: '1yr',
      message: 'a & b < c',
      claimUrl: 'https://app.test/redeem?mt=jwt',
    })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('a &amp; b &lt; c')
  })
})

// `giver_name` is free text from an unauthenticated checkout form that mails any
// address the buyer names, and the subject is both a mail header and the line a
// recipient trusts before opening. Only a name may reach it.
describe('renderGiftRedemptionEmail — subject line', () => {
  const subjectFor = (giverName: string) =>
    renderGiftRedemptionEmail({
      giverName,
      term: '1yr',
      claimUrl: 'https://app.test/redeem?mt=jwt',
    }).subject

  test('an ordinary name passes through untouched', () => {
    expect(subjectFor('Dana Levi')).toBe('Dana Levi sent you Ark+')
    expect(subjectFor("J.R. O'Neil-Cohen")).toBe("J.R. O'Neil-Cohen sent you Ark+")
    expect(subjectFor('דנה לוי')).toBe('דנה לוי sent you Ark+')
  })

  test('line breaks and control characters cannot start a new header', () => {
    const subject = subjectFor('Bob\r\nBcc: victim@example.com\u0000\u2028x')
    // eslint-disable-next-line no-control-regex
    expect(subject).not.toMatch(/[\r\n\u0000\u2028]/)
    expect(subject.startsWith('Bob Bcc:')).toBe(true)
  })

  test('collapses runs of whitespace', () => {
    expect(subjectFor('  Dana \t  Levi  ')).toBe('Dana Levi sent you Ark+')
  })

  test('strips urls and bare domains', () => {
    expect(subjectFor('Bob https://evil.example/login')).toBe('Bob sent you Ark+')
    expect(subjectFor('Bob www.evil.example')).toBe('Bob sent you Ark+')
    expect(subjectFor('Bob evil.example/x?y=1 now')).toBe('Bob now sent you Ark+')
  })

  test('a name that was nothing but a link falls back to the generic subject', () => {
    expect(subjectFor('http://evil.example')).toBe("You've been gifted Ark+")
  })

  test('caps the name at 60 characters without halving an emoji', () => {
    const subject = subjectFor('😀'.repeat(100))
    expect(subject).toBe(`${'😀'.repeat(60)} sent you Ark+`)
    expect(subjectFor('a'.repeat(300))).toBe(`${'a'.repeat(60)} sent you Ark+`)
  })

  test('the note is capped at 500 characters in the body', () => {
    const { html } = renderGiftRedemptionEmail({
      term: '1yr',
      message: 'm'.repeat(2000),
      claimUrl: 'https://app.test/redeem?mt=jwt',
    })
    expect(html).toContain('m'.repeat(500))
    expect(html).not.toContain('m'.repeat(501))
  })
})

describe('networkShowBullets', () => {
  test('names every public network show, and never the members-only one', () => {
    // The copy doc's "VISUAL BENEFITS LIST" — the shows an Ark+ membership makes
    // ad-free and early. The premium show is delivered through the private feed
    // and is not one of them, so it must not appear in this list.
    const bullets = networkShowBullets().join('\n')
    for (const show of shows) {
      if (show.paid) expect(bullets).not.toContain(show.title)
      else expect(bullets).toContain(show.title)
    }
  })

  test('carries a one-line description per show, not just the name', () => {
    const bullets = networkShowBullets()
    const callMeBack = shows.find((s) => s.slug === 'call-me-back')!
    expect(bullets.join('\n')).toContain(callMeBack.tagline)
  })

  test('no <img>: key art is still a design placeholder, and mail clients block images', () => {
    expect(networkShowBullets().join('\n')).not.toContain('<img')
  })
})

describe('renderSubscriberWelcomeEmail', () => {
  test('new account: CTA is setup, and says the link signs them in', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      ...URLS,
      name: 'Casey Jones',
      isNewAccount: true,
      tier: 'ark-plus',
    })
    expect(subject).toBe('Welcome to Ark+, one quick step left')
    expect(html).toContain('Welcome to Ark+.')
    expect(html).toContain('Hi Casey,') // first name only
    // Member-facing copy never mentions a password, in any direction: not as a
    // thing to set, and not as a thing they don't need. See welcome-email.ts.
    expect(html).not.toMatch(/password/i)
    expect(html).toContain('That link signs you in automatically')
    // The caller wraps setupUrl in an auto-login link, which is what makes a
    // CTA reachable for an account that has never signed in.
    expect(html).toContain(URLS.welcomeUrl)
    expect(html).toContain(URLS.setupUrl)
  })

  test('a name manufactured from the address falls back to "Hi there,"', () => {
    // Without the email passed alongside there is nothing to compare the
    // name against — so a local-part value would render as a greeting.
    const { html } = renderSubscriberWelcomeEmail({
      ...URLS,
      name: 'hannah.waxman8',
      email: 'hannah.waxman8@gmail.com',
      tier: 'ark-plus',
    })
    expect(html).toContain('Hi there,')
    expect(html).not.toContain('hannah.waxman8')
  })

  test('existing account: the CTA is setup itself, and says no new account is needed', () => {
    const { html } = renderSubscriberWelcomeEmail({ ...URLS, tier: 'ark-plus' })
    expect(html).toContain('Finish setup')
    expect(html).toContain(URLS.setupUrl)
    expect(html).toContain('no new account to make')
    expect(html).not.toMatch(/password/i)
    expect(html).toContain('Hi there,')
  })

  test('every welcome carries the support address, not a placeholder', () => {
    // [SUPPORT EMAIL PLACEHOLDER] in the copy doc. A shipped email must not.
    for (const tier of ['ark-plus', 'bundle'] as const) {
      const { html } = renderSubscriberWelcomeEmail({ ...URLS, tier })
      expect(html).toContain(SUPPORT_EMAIL)
      expect(html).toContain(`mailto:${SUPPORT_EMAIL}`)
      expect(html).not.toContain('PLACEHOLDER')
    }
  })

  test('ark-plus (feed-only): lists the network shows, and does not promise the Fold', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      ...URLS,
      tier: 'ark-plus',
    })
    expect(subject).toBe('Welcome to Ark+, one quick step left')
    expect(html).toContain('What you have access to')
    expect(html).toContain(ARK_PLUS_EXTRAS)
    for (const bullet of networkShowBullets()) expect(html).toContain(bullet)
    // A feed-only membership must not advertise access to the Fold it lacks.
    expect(html).not.toContain('Fold')
  })

  test('bundle: two setup steps — the feed and the Fold app', () => {
    const { subject, html } = renderSubscriberWelcomeEmail({
      ...URLS,
      tier: 'bundle',
    })
    expect(subject).toBe('Welcome to Ark+ and The Fold')
    expect(html).toContain('Welcome to Ark+ and the Fold.')
    expect(html).toContain('Getting started')
    expect(html).toContain('There are two quick steps')
    // Step one: the private feed. Step two: the app that IS the Fold.
    expect(html).toContain(URLS.setupUrl)
    expect(html).toContain(circleUrls.appStoreIos)
    expect(html).toContain(circleUrls.appStoreAndroid)
    // And the same show list as ark-plus, since the bundle includes the feed.
    for (const bullet of networkShowBullets()) expect(html).toContain(bullet)
  })
})

describe('renderCircleWelcomeEmail', () => {
  test('Fold-first: the app is the setup step, and the feed is never mentioned', () => {
    const { subject, html } = renderCircleWelcomeEmail({
      welcomeUrl: URLS.welcomeUrl,
    })
    expect(subject).toBe('Welcome to The Fold')
    expect(html).toContain('Welcome to the Fold.')
    expect(html).toContain(circleUrls.appStoreIos)
    expect(html).toContain(circleUrls.appStoreAndroid)
    expect(html).toContain("What you'll find inside")
    expect(html).toContain('Deborah Pardes')
    expect(html).toContain(SUPPORT_EMAIL)
    // No private feed on this membership, so no RSS/Spotify instructions.
    expect(html).not.toContain('RSS')
    expect(html).not.toContain('Spotify')
  })

  test('new account: CTA is the Fold, and says the link signs them in', () => {
    const { html } = renderCircleWelcomeEmail({
      welcomeUrl: URLS.welcomeUrl,
      isNewAccount: true,
    })
    expect(html).not.toMatch(/password/i)
    expect(html).toContain('Enter the Fold')
    expect(html).toContain('That link signs you in automatically')
    expect(html).toContain(URLS.welcomeUrl)
  })
})

describe('renderAxisAddedEmail', () => {
  test('states the new price as the whole cost, and that nothing is due today', () => {
    // The two things this email exists to say beyond the copy doc's version,
    // which carries no price at all. "Covers everything" is what defuses the
    // fear the price is charged ON TOP of the old one, and "nothing to pay
    // today" is the answer to the question a member actually has — the change
    // is settled on the next bill, so their card shows nothing and no one
    // guesses why.
    const { subject, html } = renderAxisAddedEmail({
      ...URLS,
      name: 'Alice Smith',
      email: 'alice@example.com',
      axis: 'circle',
      price: '$25',
      plan: 'monthly',
      renewsOn: 'September 14, 2026',
    })
    expect(subject).toBe("You've added The Fold to your membership")
    expect(html).toContain('Hi Alice,')
    expect(html).toContain('$25 a month')
    expect(html).toContain('covers everything')
    expect(html).toContain('Nothing to pay today')
    expect(html).toContain('September 14, 2026')
    expect(html).toContain('Enter the Fold')
    // Not a first-purchase welcome, and never a set-password email: this member
    // has had a login since the day they first subscribed.
    expect(html).not.toContain('Welcome to Ark+')
    expect(html).not.toMatch(/password/i)
  })

  test('speaks in bills and months, never in our billing vocabulary', () => {
    // The words this copy was workshopped OUT of. Members have bills and
    // months; "prorated", "invoice" and "billing period" are our machinery,
    // and they read as a company talking to itself.
    const { html } = renderAxisAddedEmail({
      ...URLS,
      axis: 'circle',
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
      ...URLS,
      axis: 'circle',
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
      ...URLS,
      axis: 'circle',
      plan: 'monthly',
    })
    expect(html).toContain('covers everything')
    expect(html).toContain('Nothing to pay today')
    expect(html).not.toContain('$')
    // No date given → no promise about which day the bill lands.
    expect(html).not.toContain('Your next bill is')
  })

  test('adding the Fold: carries the app links and the profile setup link', () => {
    // A new Fold member meets the download step on /welcome. Someone who
    // upgrades from their account page never passes through it, so the links
    // have to travel in the email itself — getting the app IS the step that
    // puts them in the Fold, and the profile is what makes them a person
    // in it rather than an email address.
    const { html } = renderAxisAddedEmail({
      ...URLS,
      axis: 'circle',
      price: '$25',
      plan: 'monthly',
    })
    expect(html).toContain("there's just one more step")
    expect(html).toContain(circleUrls.appStoreIos)
    expect(html).toContain(circleUrls.appStoreAndroid)
    expect(html).toContain(circleUrls.webApp)
    expect(html).toContain(circleUrls.profileSettings)
    expect(html).toContain("What you'll find inside")
    expect(html).toContain(SUPPORT_EMAIL)
    // Text links, not the store badge lockups: SVG doesn't render in most mail
    // clients, and image blocking would leave the row empty in the rest.
    expect(html).not.toContain('<img')
  })

  test('adding Ark+: feed copy and the feed setup CTA', () => {
    const { subject, html } = renderAxisAddedEmail({
      ...URLS,
      axis: 'ark-plus',
      price: '$25',
      plan: 'monthly',
    })
    expect(subject).toContain('feed')
    expect(html).toContain(FEED_INCLUDED)
    expect(html).toContain('Set up your feed')
    expect(html).toContain(URLS.setupUrl)
    expect(html).not.toContain('Enter the Fold')
    // The Fold app links belong to the axis that grants the Fold.
    expect(html).not.toContain(circleUrls.appStoreIos)
  })
})
