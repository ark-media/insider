// Tests for the Beehiiv show-notes sanitizer and the upstream → Episode
// projection. The sanitizer output reaches the user's browser as real HTML
// via html-react-parser, so these tests pin both the allowlist and the
// projection's preference for show_notes over description.

import { describe, test, expect } from 'bun:test'
import {
  isPublishedEpisode,
  projectBeehiivEpisode,
  sanitizeShowNotes,
  type BeehiivEpisode,
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

describe('projectBeehiivEpisode', () => {
  // 2026-05-04T13:00:00Z. Beehiiv dates are unix SECONDS, not ISO strings —
  // that difference is the single most likely way this projection breaks.
  const DISPLAYED_AT = 1777899600
  const baseEpisode: BeehiivEpisode = {
    id: 'ep-1',
    slug: 'the-day-after',
    title: 'The day after',
    description: 'Short blurb.',
    duration: 3840, // 64 minutes
    displayed_date: DISPLAYED_AT,
    status: 'published',
  }

  test('prefers show_notes for showNotesHtml', () => {
    const out = projectBeehiivEpisode(
      {
        ...baseEpisode,
        description: '<p>Short.</p>',
        show_notes: '<p>Long form notes with <a href="https://x.test">links</a>.</p>',
      },
      'call-me-back',
    )
    expect(out.showNotesHtml).toContain('Long form notes')
    expect(out.showNotesHtml).toContain('href="https://x.test"')
    // description (the lede) stays as the short, stripped form.
    expect(out.description).toBe('Short.')
  })

  test('falls back to description when show_notes is missing', () => {
    const out = projectBeehiivEpisode(
      { ...baseEpisode, description: '<p>Only short.</p>' },
      'call-me-back',
    )
    expect(out.showNotesHtml).toContain('Only short.')
    expect(out.description).toBe('Only short.')
  })

  test('shapes the rest of the projection', () => {
    const out = projectBeehiivEpisode(baseEpisode, 'call-me-back')
    expect(out.showSlug).toBe('call-me-back')
    expect(out.id).toBe('ep-1')
    expect(out.slug).toBe('the-day-after')
    expect(out.title).toBe('The day after')
    expect(out.publishedAt).toBe('2026-05-04')
    expect(out.durationMinutes).toBe(64)
  })

  test('converts unix-second dates, falling back to publish_date', () => {
    expect(
      projectBeehiivEpisode(
        { ...baseEpisode, displayed_date: undefined, publish_date: DISPLAYED_AT },
        'call-me-back',
      ).publishedAt,
    ).toBe('2026-05-04')
  })

  test('carries the audio url — the player has nothing to play without it', () => {
    expect(
      projectBeehiivEpisode(
        { ...baseEpisode, audio_url: 'https://media.beehiiv.test/ep-1.mp3' },
        'call-me-back',
      ).audioUrl,
    ).toBe('https://media.beehiiv.test/ep-1.mp3')
    expect(projectBeehiivEpisode(baseEpisode, 'call-me-back').audioUrl).toBe('')
  })

  test('carries episode artwork when present, empty string otherwise', () => {
    expect(
      projectBeehiivEpisode(
        { ...baseEpisode, artwork_url: 'https://img.test/ep-1.jpg' },
        'call-me-back',
      ).imageUrl,
    ).toBe('https://img.test/ep-1.jpg')
    expect(projectBeehiivEpisode(baseEpisode, 'call-me-back').imageUrl).toBe('')
  })

  test('falls back to the id when Beehiiv has no slug', () => {
    expect(
      projectBeehiivEpisode({ ...baseEpisode, slug: undefined }, 'call-me-back').slug,
    ).toBe('ep-1')
  })

  test('handles missing fields without throwing', () => {
    const out = projectBeehiivEpisode({}, 'call-me-back')
    expect(out.id).toBe('')
    expect(out.slug).toBe('')
    expect(out.title).toBe('')
    expect(out.publishedAt).toBe('')
    expect(out.durationMinutes).toBe(0)
    expect(out.description).toBe('')
    expect(out.showNotesHtml).toBe('')
    expect(out.imageUrl).toBe('')
    expect(out.audioUrl).toBe('')
  })
})

describe('isPublishedEpisode', () => {
  const AT = 1777899600
  test.each<[string, BeehiivEpisode, boolean]>([
    ['keeps published episodes with id and a date', { id: 'ep-1', displayed_date: AT, status: 'published' }, true],
    ['accepts publish_date when displayed_date is absent', { id: 'ep-1', publish_date: AT, status: 'published' }, true],
    ['drops drafts', { id: 'ep-1', displayed_date: AT, status: 'draft' }, false],
    ['drops scheduled episodes', { id: 'ep-1', displayed_date: AT, status: 'scheduled' }, false],
    ['drops archived episodes', { id: 'ep-1', displayed_date: AT, status: 'archived' }, false],
    // Fails closed: an unrecognised future status must not reach the public site.
    ['drops episodes with no status at all', { id: 'ep-1', displayed_date: AT }, false],
    ['drops episodes with no date', { id: 'ep-1', status: 'published' }, false],
    ['drops episodes with no id', { displayed_date: AT, status: 'published' }, false],
  ])('%s', (_name, episode, expected) => {
    expect(isPublishedEpisode(episode)).toBe(expected)
  })
})
