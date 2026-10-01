import { describe, expect, test } from 'bun:test'
import { withEmailUtm } from './email'

describe('withEmailUtm', () => {
  test('tags a bare path and keeps it a path', () => {
    expect(withEmailUtm('/offer', 'welcome-offer')).toBe(
      '/offer?utm_source=ark-plus&utm_medium=email&utm_campaign=welcome-offer',
    )
  })

  test('tags an absolute URL, keeping its existing query and hash', () => {
    expect(withEmailUtm('https://ark-plus.xyz/redeem?mt=abc#top', 'gift-claim')).toBe(
      'https://ark-plus.xyz/redeem?mt=abc&utm_source=ark-plus&utm_medium=email&utm_campaign=gift-claim#top',
    )
  })

  test('leaves an already-tagged link alone', () => {
    expect(withEmailUtm('/x?utm_source=partner', 'c')).toBe('/x?utm_source=partner')
  })
})
