import { describe, test, expect } from 'bun:test'
import { renderFeedMoveEmail } from './feed-move-email'

const base = {
  setupUrl: 'https://ark-plus.xyz/api/auth/email-login?lt=t&to=%2Fsetup',
  assetBaseUrl: 'https://ark-plus.xyz/',
}

describe('renderFeedMoveEmail', () => {
  test('sends members to their own setup link', () => {
    const { html } = renderFeedMoveEmail(base)
    expect(html).toMatch(/<a href="https:\/\/ark-plus\.xyz\/api\/auth\/email-login\?lt=t&to=%2Fsetup"[^>]*>Move my feed/)
  })

  test('names no switch-off date: members should move now', () => {
    const { html } = renderFeedMoveEmail(base)
    expect(html).not.toMatch(/December|Dec 31|2026/)
  })

  test('serves its art from the given origin, without a double slash', () => {
    const { html } = renderFeedMoveEmail(base)
    expect(html).toContain('src="https://ark-plus.xyz/email/feed-move-shows.jpg"')
    expect(html).toContain('src="https://ark-plus.xyz/shows/call-me-back-400.jpg"')
    expect(html).not.toContain('xyz//')
  })

  test('is transactional: no unsubscribe block', () => {
    const { html } = renderFeedMoveEmail(base)
    expect(html.toLowerCase()).not.toContain('unsubscribe')
  })
})
