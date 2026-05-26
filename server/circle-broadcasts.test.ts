// Tests for the Circle Broadcasts sanitizer and upstream → NewsletterPost
// projection. The sanitizer output reaches the user's browser as real HTML via
// html-react-parser, so these tests pin both the allowlist and the projection's
// tag-based tier promotion.

import { describe, test, expect } from 'bun:test'
import {
  broadcastSlug,
  isSentBroadcast,
  projectBroadcast,
  sanitizeBroadcastHtml,
  type CircleBroadcast,
} from './circle-broadcasts'

describe('sanitizeBroadcastHtml', () => {
  test('preserves common broadcast tags including <img>', () => {
    const out = sanitizeBroadcastHtml(
      '<p>Intro.</p><img src="https://x.test/a.png" alt="a"><ul><li>One</li></ul>',
    )
    expect(out).toContain('<p>Intro.</p>')
    expect(out).toContain('<img src="https://x.test/a.png"')
    expect(out).toContain('<li>One</li>')
  })

  test('strips script tags and event handlers', () => {
    const out = sanitizeBroadcastHtml(
      '<p>Hi <img src=x onerror="alert(1)">there</p><script>alert(2)</script>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).toContain('Hi')
    expect(out).toContain('there')
  })

  test('rewrites <a> with safe target and rel', () => {
    const out = sanitizeBroadcastHtml(
      '<p>See <a href="https://example.com/x">notes</a>.</p>',
    )
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('drops javascript: hrefs', () => {
    const out = sanitizeBroadcastHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })
})

describe('projectBroadcast', () => {
  const base: CircleBroadcast = {
    id: 42,
    subject: 'The week in numbers',
    preview_text: 'Polling, bond markets, and the IDF reorg.',
    email_body_html: '<p>Three things this week.</p>',
    sent_at: '2026-04-27T12:00:00Z',
    status: 'sent',
    tags: ['call-me-back'],
  }

  test('projects to NewsletterPost shape with stable slug', () => {
    const out = projectBroadcast(base, 'ark-daily', 'Dan Senor')
    expect(out).not.toBeNull()
    expect(out!.slug).toBe('broadcast-42')
    expect(out!.title).toBe('The week in numbers')
    expect(out!.publishedAt).toBe('2026-04-27')
    expect(out!.excerpt).toBe('Polling, bond markets, and the IDF reorg.')
    expect(out!.bodyHtml).toContain('<p>Three things this week.</p>')
    expect(out!.tier).toBe('free')
    expect(out!.authorName).toBe('Dan Senor')
  })

  test('promotes tier to ark-plus when broadcast carries members-only tag', () => {
    const out = projectBroadcast(
      { ...base, tags: ['call-me-back', 'members-only'] },
      'ark-daily',
      'Dan Senor',
    )
    expect(out!.tier).toBe('ark-plus')
  })

  test('drops broadcasts with no sent_at / scheduled_at / created_at', () => {
    const out = projectBroadcast(
      { ...base, sent_at: undefined, scheduled_at: undefined, created_at: undefined },
      'ark-daily',
      'Dan Senor',
    )
    expect(out).toBeNull()
  })

  test('falls back to stripped HTML for excerpt when preview_text missing', () => {
    const out = projectBroadcast(
      { ...base, preview_text: undefined, email_body_html: '<p>Hello <strong>world</strong>.</p>' },
      'ark-daily',
      'Dan Senor',
    )
    expect(out!.excerpt).toContain('Hello world')
  })
})

describe('isSentBroadcast', () => {
  test('accepts sent broadcasts', () => {
    expect(isSentBroadcast({ status: 'sent', sent_at: '2026-04-27' })).toBe(true)
  })
  test('rejects drafts', () => {
    expect(isSentBroadcast({ status: 'draft', sent_at: '2026-04-27' })).toBe(false)
  })
  test('accepts broadcasts with no status but a timestamp', () => {
    expect(isSentBroadcast({ sent_at: '2026-04-27' })).toBe(true)
  })
})

describe('broadcastSlug', () => {
  test('produces stable url-safe slugs from numeric and string ids', () => {
    expect(broadcastSlug(42)).toBe('broadcast-42')
    expect(broadcastSlug('abc-123')).toBe('broadcast-abc-123')
  })
})
