// Tests for the Simplecast show-notes sanitizer and the upstream → Episode
// projection. The sanitizer output reaches the user's browser as real HTML
// via html-react-parser, so these tests pin both the allowlist and the
// projection's preference for long_description over description.

import { describe, test, expect } from 'bun:test'
import {
  isPublishedEpisode,
  projectScEpisode,
  sanitizeShowNotes,
  type ScEpisode,
} from './show-notes'

describe('sanitizeShowNotes', () => {
  test('preserves common podcast show-notes tags', () => {
    const out = sanitizeShowNotes(
      '<p>Intro.</p><ul><li>One</li><li>Two</li></ul><p><strong>Note:</strong> <em>read this</em>.</p>',
    )
    expect(out).toContain('<p>Intro.</p>')
    expect(out).toContain('<ul>')
    expect(out).toContain('<li>One</li>')
    expect(out).toContain('<strong>Note:</strong>')
    expect(out).toContain('<em>read this</em>')
  })

  test('strips script tags and event handlers', () => {
    const out = sanitizeShowNotes(
      '<p>Hi <img src=x onerror="alert(1)">there</p><script>alert(2)</script>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<img')
    expect(out).toContain('Hi')
    expect(out).toContain('there')
  })

  test('rewrites <a> with safe target and rel', () => {
    const out = sanitizeShowNotes(
      '<p>See <a href="https://example.com/x">our notes</a>.</p>',
    )
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('drops javascript: hrefs', () => {
    const out = sanitizeShowNotes('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
  })

  test('preserves mailto: hrefs', () => {
    const out = sanitizeShowNotes('<a href="mailto:dan@example.com">email</a>')
    expect(out).toContain('href="mailto:dan@example.com"')
  })

  test('drops <u> tags (would collide with link underline styling)', () => {
    const out = sanitizeShowNotes('<p>see <u>this</u></p>')
    expect(out).not.toContain('<u>')
    expect(out).toContain('this')
  })

  test('returns empty string for empty input', () => {
    expect(sanitizeShowNotes('')).toBe('')
  })
})

describe('projectScEpisode', () => {
  const baseEpisode: ScEpisode = {
    id: 'ep-1',
    slug: 'the-day-after',
    title: 'The day after',
    description: 'Short blurb.',
    duration: 3840, // 64 minutes
    published_at: '2026-04-27T13:00:00.000Z',
  }

  test('prefers long_description for showNotesHtml', () => {
    const out = projectScEpisode(
      {
        ...baseEpisode,
        description: '<p>Short.</p>',
        long_description: '<p>Long form notes with <a href="https://x.test">links</a>.</p>',
      },
      'call-me-back',
    )
    expect(out.showNotesHtml).toContain('Long form notes')
    expect(out.showNotesHtml).toContain('href="https://x.test"')
    // description (the lede) stays as the short, stripped form.
    expect(out.description).toBe('Short.')
  })

  test('falls back to description when long_description is missing', () => {
    const out = projectScEpisode(
      { ...baseEpisode, description: '<p>Only short.</p>' },
      'call-me-back',
    )
    expect(out.showNotesHtml).toContain('Only short.')
    expect(out.description).toBe('Only short.')
  })

  test('shapes the rest of the projection', () => {
    const out = projectScEpisode(baseEpisode, 'call-me-back')
    expect(out.showSlug).toBe('call-me-back')
    expect(out.id).toBe('ep-1')
    expect(out.slug).toBe('the-day-after')
    expect(out.title).toBe('The day after')
    expect(out.publishedAt).toBe('2026-04-27')
    expect(out.durationMinutes).toBe(64)
  })

  test('carries episode artwork when present, empty string otherwise', () => {
    expect(
      projectScEpisode(
        { ...baseEpisode, image_url: 'https://img.test/ep-1.jpg' },
        'call-me-back',
      ).imageUrl,
    ).toBe('https://img.test/ep-1.jpg')
    expect(projectScEpisode(baseEpisode, 'call-me-back').imageUrl).toBe('')
  })

  test('handles missing fields without throwing', () => {
    const out = projectScEpisode({}, 'call-me-back')
    expect(out.id).toBe('')
    expect(out.slug).toBe('')
    expect(out.title).toBe('')
    expect(out.publishedAt).toBe('')
    expect(out.durationMinutes).toBe(0)
    expect(out.description).toBe('')
    expect(out.showNotesHtml).toBe('')
    expect(out.imageUrl).toBe('')
  })
})

describe('isPublishedEpisode', () => {
  test('keeps published episodes with id and published_at', () => {
    expect(
      isPublishedEpisode({
        id: 'ep-1',
        published_at: '2026-04-27T13:00:00.000Z',
        is_published: true,
      }),
    ).toBe(true)
  })

  test('drops drafts (is_published: false)', () => {
    expect(
      isPublishedEpisode({
        id: 'ep-1',
        published_at: '2026-04-27T13:00:00.000Z',
        is_published: false,
      }),
    ).toBe(false)
  })

  test('drops episodes with no published_at (scheduled)', () => {
    expect(isPublishedEpisode({ id: 'ep-1' })).toBe(false)
  })

  test('drops episodes with no id', () => {
    expect(
      isPublishedEpisode({ published_at: '2026-04-27T13:00:00.000Z' }),
    ).toBe(false)
  })
})
