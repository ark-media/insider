// Tests for the Circle space-posts → NewsletterPost projection. Mirrors
// circle-broadcasts.test.ts. The sanitizer itself is exercised by the
// broadcasts suite — these tests focus on what's different here: post slug
// preference, body-shape variants (string vs { html }), and published_at
// fallback to created_at.

import { describe, test, expect } from 'bun:test'
import {
  isPublishedPost,
  projectSpacePost,
  type CirclePost,
} from './circle-space-posts'

describe('projectSpacePost', () => {
  const base: CirclePost = {
    id: 7,
    name: 'Code of conduct — please read',
    slug: 'code-of-conduct-please-read',
    body: '<p>Treat each other with respect.</p>',
    published_at: '2026-03-10T12:00:00Z',
    status: 'published',
    space_id: 999,
    space_slug: 'ark-code-of-conduct',
  }

  test('projects to NewsletterPost using Circle post slug', () => {
    const out = projectSpacePost(base, 'members-letter', 'Ark Media editorial', 'ark-plus')
    expect(out).not.toBeNull()
    expect(out!.slug).toBe('code-of-conduct-please-read')
    expect(out!.title).toBe('Code of conduct — please read')
    expect(out!.publishedAt).toBe('2026-03-10')
    expect(out!.bodyHtml).toContain('<p>Treat each other with respect.</p>')
    expect(out!.tier).toBe('ark-plus')
    expect(out!.authorName).toBe('Ark Media editorial')
  })

  test('falls back to post-{id} slug when Circle slug is missing', () => {
    const out = projectSpacePost(
      { ...base, slug: undefined },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out!.slug).toBe('post-7')
  })

  test('accepts body as object with .html', () => {
    const out = projectSpacePost(
      { ...base, body: { html: '<p>Hi <em>there</em>.</p>' } },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out!.bodyHtml).toContain('<p>Hi <em>there</em>.</p>')
    expect(out!.body).toContain('Hi there')
  })

  test('accepts body as ActionText rich_text record with nested .body HTML', () => {
    // Circle's /api/admin/v2/posts list endpoint returns `body` as a Rails
    // ActionText record: { id, name, body: '<html...>', record_type, record_id, ... }.
    // The rendered HTML lives at body.body — see circle.ts diagnostic log
    // confirmation from 2026-05-12.
    const out = projectSpacePost(
      {
        ...base,
        body: {
          id: 42,
          name: 'body',
          body: '<div><p><strong>Be respectful.</strong></p></div>',
          record_type: 'Post',
          record_id: 7,
        },
      },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out!.bodyHtml).toContain('<strong>Be respectful.</strong>')
    expect(out!.body).toContain('Be respectful.')
  })

  test('falls back to created_at when published_at missing', () => {
    const out = projectSpacePost(
      { ...base, published_at: undefined, created_at: '2026-01-02T00:00:00Z' },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out!.publishedAt).toBe('2026-01-02')
  })

  test('drops posts with neither published_at nor created_at', () => {
    const out = projectSpacePost(
      { ...base, published_at: undefined, created_at: undefined },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out).toBeNull()
  })

  test('drops posts with no id', () => {
    const out = projectSpacePost(
      { ...base, id: undefined },
      'members-letter',
      'Ark Media editorial',
      'ark-plus',
    )
    expect(out).toBeNull()
  })
})

describe('isPublishedPost', () => {
  test('accepts published posts', () => {
    expect(
      isPublishedPost({ status: 'published', published_at: '2026-03-10' }),
    ).toBe(true)
  })
  test('rejects drafts', () => {
    expect(
      isPublishedPost({ status: 'draft', published_at: '2026-03-10' }),
    ).toBe(false)
  })
  test('accepts posts with no status but a timestamp', () => {
    expect(isPublishedPost({ published_at: '2026-03-10' })).toBe(true)
  })
  test('rejects posts with no timestamps', () => {
    expect(isPublishedPost({ status: 'published' })).toBe(false)
  })
})
