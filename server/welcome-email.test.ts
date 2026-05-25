import { describe, test, expect } from 'bun:test'
import {
  renderGiftWelcomeEmail,
  renderSubscriberWelcomeEmail,
} from './lib/welcome-email'

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
    })
    expect(subject).toBe('Welcome to Ark+')
    expect(html).toContain('Welcome to Ark+.')
    expect(html).toContain('Hi Casey,') // first name only
    expect(html).toContain('Set your password')
    expect(html).toContain('https://auth.test/u/reset?ticket=xyz')
    expect(html).toContain('https://app.test/welcome')
  })

  test('existing account: log-in CTA, no ticket', () => {
    const { html } = renderSubscriberWelcomeEmail({
      welcomeUrl: 'https://app.test/welcome',
    })
    expect(html).toContain('Start listening')
    expect(html).toContain('already have an Ark+ login')
    expect(html).not.toContain('Set your password')
    expect(html).toContain('Hi there,')
  })
})
