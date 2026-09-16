// Tests for the Beehiiv post sanitizer and upstream → NewsletterPost
// projection. The sanitizer output reaches the user's browser as real HTML
// via html-react-parser, so these tests pin both the allowlist and the
// projection's audience-to-tier mapping.

import { describe, test, expect } from 'bun:test'
import {
  isPublishedBeehiivPost,
  projectBeehiivPost,
  sanitizeBeehiivHtml,
  type BeehiivPost,
} from './beehiiv-posts'

describe('sanitizeBeehiivHtml', () => {
  test('preserves common newsletter tags including images and hr', () => {
    const out = sanitizeBeehiivHtml(
      '<p>Intro.</p><hr><img src="https://x.test/a.png" alt="a"><blockquote>Quote</blockquote>',
    )
    expect(out).toContain('<p>Intro.</p>')
    expect(out).toContain('<hr')
    expect(out).toContain('<img src="https://x.test/a.png"')
    expect(out).toContain('<blockquote>Quote</blockquote>')
  })

  test('strips script tags and event handlers', () => {
    const out = sanitizeBeehiivHtml(
      '<p>Hi <img src=x onerror="alert(1)">there</p><script>alert(2)</script>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).toContain('Hi')
    expect(out).toContain('there')
  })

  test('rewrites <a> with safe target and rel', () => {
    const out = sanitizeBeehiivHtml(
      '<p>See <a href="https://example.com/x">notes</a>.</p>',
    )
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  test('drops javascript: hrefs', () => {
    const out = sanitizeBeehiivHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })

  test('drops Beehiiv default gradient_avatar images', () => {
    const out = sanitizeBeehiivHtml(
      '<p>Body.</p><img src="https://media.beehiiv.com/cdn-cgi/image/fit=scale-down/static_assets/gradient_avatar_1.png" alt="">',
    )
    expect(out).toContain('<p>Body.</p>')
    expect(out).not.toContain('gradient_avatar')
    expect(out).not.toContain('<img')
  })
})

describe('projectBeehiivPost', () => {
  const base: BeehiivPost = {
    id: 'post_abc',
    title: 'The week in numbers',
    subtitle: 'Polling, bond markets, the IDF reorg',
    slug: 'the-week-in-numbers',
    status: 'confirmed',
    audience: 'free',
    publish_date: 1714161600, // 2024-04-26 in unix seconds
    preview_text: 'Polling, bond markets, and the IDF reorg.',
    authors: [{ name: 'Dan Senor' }],
    content: {
      free: { web: '<p>Three things this week.</p>' },
      premium: { web: '<p>SECRET premium body that must not leak.</p>' },
    },
  }

  test('projects to NewsletterPost with free content and ISO date', () => {
    const out = projectBeehiivPost(base, 'ark-daily', 'Author')
    expect(out).not.toBeNull()
    expect(out!.slug).toBe('the-week-in-numbers')
    expect(out!.title).toBe('The week in numbers')
    expect(out!.publishedAt).toBe('2024-04-26')
    expect(out!.excerpt).toBe('Polling, bond markets, and the IDF reorg.')
    expect(out!.bodyHtml).toContain('<p>Three things this week.</p>')
    expect(out!.tier).toBe('free')
    expect(out!.authorName).toBe('Dan Senor')
  })

  test('never projects premium body content with the default (free) view', () => {
    const out = projectBeehiivPost(base, 'ark-daily', 'Author')
    expect(out!.bodyHtml).not.toContain('SECRET')
    expect(out!.body).not.toContain('SECRET')
  })

  test('projects the premium body when view=premium', () => {
    const out = projectBeehiivPost(
      { ...base, audience: 'premium' },
      'members-letter',
      'Author',
      'premium',
    )
    expect(out!.bodyHtml).toContain('SECRET premium body')
    expect(out!.body).toContain('SECRET premium body')
  })

  test('premium view falls back to free body when premium.web is empty', () => {
    const out = projectBeehiivPost(
      {
        ...base,
        content: {
          free: { web: '<p>Free fallback.</p>' },
          premium: { web: '   ' },
        },
      },
      'members-letter',
      'Author',
      'premium',
    )
    expect(out!.bodyHtml).toContain('Free fallback')
  })

  test('promotes tier to ark-plus when audience is premium', () => {
    const out = projectBeehiivPost(
      { ...base, audience: 'premium' },
      'members-letter',
      'Author',
    )
    expect(out!.tier).toBe('ark-plus')
  })

  test('treats audience=both as free on the free surface', () => {
    const out = projectBeehiivPost(
      { ...base, audience: 'both' },
      'ark-daily',
      'Author',
    )
    expect(out!.tier).toBe('free')
  })

  test('treats audience=both as ark-plus on the members surface', () => {
    const out = projectBeehiivPost(
      { ...base, audience: 'both' },
      'members-letter',
      'Author',
    )
    expect(out!.tier).toBe('ark-plus')
  })

  test('returns null when id or slug is missing', () => {
    expect(
      projectBeehiivPost({ ...base, id: undefined }, 'ark-daily', 'A'),
    ).toBeNull()
    expect(
      projectBeehiivPost({ ...base, slug: undefined }, 'ark-daily', 'A'),
    ).toBeNull()
  })

  test('returns null when no publish_date is available', () => {
    expect(
      projectBeehiivPost(
        { ...base, publish_date: undefined, displayed_date: undefined },
        'ark-daily',
        'A',
      ),
    ).toBeNull()
  })

  test('falls back to subtitle then stripped HTML for excerpt', () => {
    const noPreview = projectBeehiivPost(
      { ...base, preview_text: undefined },
      'ark-daily',
      'A',
    )
    expect(noPreview!.excerpt).toBe('Polling, bond markets, the IDF reorg')

    const noPreviewNoSubtitle = projectBeehiivPost(
      {
        ...base,
        preview_text: undefined,
        subtitle: undefined,
        content: { free: { web: '<p>Hello <strong>world</strong>.</p>' } },
      },
      'ark-daily',
      'A',
    )
    expect(noPreviewNoSubtitle!.excerpt).toContain('Hello world')
  })

  test('excerpt fallback does not leak <style> block contents', () => {
    const out = projectBeehiivPost(
      {
        ...base,
        preview_text: undefined,
        subtitle: undefined,
        content: {
          free: {
            web:
              "<style>:root { --wt-primary-color: #030712; --wt-text-on-primary-color: #FFFFFF; }</style>" +
              '<p>Real body starts here.</p>',
          },
        },
      },
      'ark-daily',
      'A',
    )
    expect(out!.excerpt).not.toContain('--wt-')
    expect(out!.excerpt).not.toContain('#030712')
    expect(out!.excerpt).toContain('Real body starts here')
  })

  test('falls back to author fallback when authors[] is empty', () => {
    const out = projectBeehiivPost(
      { ...base, authors: [] },
      'ark-daily',
      'Ark Media newsroom',
    )
    expect(out!.authorName).toBe('Ark Media newsroom')
  })
})

describe('isPublishedBeehiivPost', () => {
  test.each<[string, BeehiivPost, boolean]>([
    ['accepts confirmed posts with a publish_date', { id: 'post_a', status: 'confirmed', publish_date: 1714161600 }, true],
    ['rejects drafts', { id: 'post_a', status: 'draft', publish_date: 1714161600 }, false],
    ['rejects scheduled posts', { id: 'post_a', status: 'scheduled', publish_date: 1714161600 }, false],
    ['rejects posts with no id', { status: 'confirmed', publish_date: 1714161600 }, false],
    ['rejects posts with no publish_date', { id: 'post_a', status: 'confirmed' }, false],
  ])('%s', (_name, post, expected) => {
    expect(isPublishedBeehiivPost(post)).toBe(expected)
  })
})
