/// <reference types="bun" />
// Projection unit tests for the PUBLIC /fold marketing showcase.
//
// The narrowing rules here are the ones that make it safe to serve community
// content to logged-out visitors, so they get pinned hardest: the space
// allowlist, the surname reduction, and the city reduction. HTTP/pagination
// wiring is covered in routes/circle.test.ts.

import { describe, test, expect } from 'bun:test'
import {
  cityFromLocation,
  projectShowcasePost,
  publicAuthorName,
  selectShowcasePosts,
  SHOWCASE_SPACE_SLUGS,
  type CircleShowcasePost,
} from './circle-showcase.js'
import type { ShowcasePost } from '../shared/community.js'

const base: CircleShowcasePost = {
  id: 36104845,
  name: 'Round challah tutorial',
  space_slug: 'ask-share',
  space_name: 'Ask & Share',
  status: 'published',
  published_at: '2026-09-03T13:50:10.122Z',
  user_name: 'Ava Weiner',
  user_email: 'ava@arkmedia.org',
  user_avatar_url: 'https://app.circle.so/avatar.png',
  comments_count: 4,
  likes_count: 1,
  url: 'https://thefold.arkmedia.org/c/ask-share/round-challah-tutorial',
}

describe('publicAuthorName', () => {
  test('reduces the surname to an initial', () => {
    expect(publicAuthorName('Ava Weiner')).toBe('Ava W.')
    expect(publicAuthorName('Deborah Pardes')).toBe('Deborah P.')
  })

  test('keeps middle names but only initials the last', () => {
    expect(publicAuthorName('Sarah Beth Cohen')).toBe('Sarah Beth C.')
  })

  test('passes a single-word name through — no surname to withhold', () => {
    expect(publicAuthorName('Miriam')).toBe('Miriam')
  })

  test('does not double-punctuate an already-initialled name', () => {
    expect(publicAuthorName('Ava W.')).toBe('Ava W.')
  })

  test('collapses stray whitespace', () => {
    expect(publicAuthorName('  Ava   Weiner ')).toBe('Ava W.')
  })

  test('falls back rather than rendering an empty byline', () => {
    expect(publicAuthorName(undefined)).toBe('A Fold member')
    expect(publicAuthorName('   ')).toBe('A Fold member')
  })
})

describe('cityFromLocation', () => {
  test('keeps only the city from a geocoded location', () => {
    expect(cityFromLocation('New York City, New York, United States')).toBe(
      'New York City',
    )
    expect(cityFromLocation('Toronto, Ontario, Canada')).toBe('Toronto')
  })

  test('passes a bare city through', () => {
    expect(cityFromLocation('London')).toBe('London')
  })

  test('is undefined when unset, so the card omits the line', () => {
    expect(cityFromLocation(undefined)).toBeUndefined()
    expect(cityFromLocation('')).toBeUndefined()
    expect(cityFromLocation('  ')).toBeUndefined()
  })
})

describe('projectShowcasePost', () => {
  test('maps the card fields and abbreviates the author', () => {
    const p = projectShowcasePost(base, {
      location: 'New York City, New York, United States',
    })!
    expect(p.id).toBe('36104845')
    expect(p.authorName).toBe('Ava W.')
    expect(p.authorLocation).toBe('New York City')
    expect(p.roomSlug).toBe('ask-share')
    expect(p.roomName).toBe('Ask & Share')
    expect(p.text).toBe('Round challah tutorial')
    expect(p.replyCount).toBe(4)
    expect(p.likeCount).toBe(1)
    expect(p.href).toBe(
      'https://thefold.arkmedia.org/c/ask-share/round-challah-tutorial',
    )
  })

  test('never carries the author email off the server', () => {
    const p = projectShowcasePost(base, {})!
    expect(JSON.stringify(p)).not.toContain('ava@arkmedia.org')
  })

  test('refuses a space outside the allowlist', () => {
    // say-hi is "Introduce Yourself" — the most personal space in the
    // community and the one this must never publish.
    expect(projectShowcasePost({ ...base, space_slug: 'say-hi' })).toBeNull()
    expect(
      projectShowcasePost({ ...base, space_slug: 'announcements' }),
    ).toBeNull()
    expect(projectShowcasePost({ ...base, space_slug: undefined })).toBeNull()
  })

  test('allowlist is exactly the three conversational rooms', () => {
    expect([...SHOWCASE_SPACE_SLUGS]).toEqual([
      'conversation',
      'ask-share',
      'lounge',
    ])
  })

  test('falls back to the body when the post is untitled', () => {
    const p = projectShowcasePost({
      ...base,
      name: '',
      body: { body: '<p>The Israeli elections are fast approaching.</p>' },
    })!
    expect(p.text).toBe('The Israeli elections are fast approaching.')
  })

  test('truncates a long body to one card-sized line', () => {
    const p = projectShowcasePost({
      ...base,
      name: undefined,
      body: { body: `<p>${'word '.repeat(80)}</p>` },
    })!
    expect(p.text.length).toBeLessThanOrEqual(161)
    expect(p.text.endsWith('…')).toBe(true)
  })

  test('drops a post with neither title nor body text', () => {
    expect(
      projectShowcasePost({ ...base, name: '', body: { body: '' } }),
    ).toBeNull()
  })

  test('drops an unpublished post', () => {
    expect(projectShowcasePost({ ...base, status: 'draft' })).toBeNull()
  })

  test('drops a post with no usable date', () => {
    expect(
      projectShowcasePost({
        ...base,
        published_at: undefined,
        created_at: undefined,
      }),
    ).toBeNull()
  })

  test('defaults missing counts to zero rather than NaN', () => {
    const p = projectShowcasePost({
      ...base,
      comments_count: undefined,
      likes_count: undefined,
    })!
    expect(p.replyCount).toBe(0)
    expect(p.likeCount).toBe(0)
  })

  test('omits the location when the member has not set one', () => {
    expect(projectShowcasePost(base, {})!.authorLocation).toBeUndefined()
  })
})

describe('selectShowcasePosts', () => {
  const post = (
    id: string,
    roomSlug: string,
    publishedAt: string,
  ): ShowcasePost => ({
    id,
    authorName: 'Ava W.',
    roomSlug,
    roomName: roomSlug,
    text: id,
    replyCount: 0,
    likeCount: 0,
    publishedAt,
    href: `https://thefold.arkmedia.org/${id}`,
  })

  test('caps a busy room so the grid still reads as three rooms', () => {
    const posts = [
      post('a1', 'ask-share', '2026-09-10'),
      post('a2', 'ask-share', '2026-09-09'),
      post('a3', 'ask-share', '2026-09-08'),
      post('a4', 'ask-share', '2026-09-07'),
      post('c1', 'conversation', '2026-09-06'),
      post('l1', 'lounge', '2026-09-05'),
    ]
    const picked = selectShowcasePosts(posts, 4, 2)
    const rooms = picked.map((p) => p.roomSlug)
    expect(rooms.filter((r) => r === 'ask-share')).toHaveLength(2)
    expect(rooms).toContain('conversation')
    expect(rooms).toContain('lounge')
  })

  test('relaxes the cap rather than under-filling the grid', () => {
    const posts = [
      post('a1', 'ask-share', '2026-09-10'),
      post('a2', 'ask-share', '2026-09-09'),
      post('a3', 'ask-share', '2026-09-08'),
      post('c1', 'conversation', '2026-09-07'),
    ]
    expect(selectShowcasePosts(posts, 4, 2)).toHaveLength(4)
  })

  test('returns recency order even when the cap forced a backfill', () => {
    const posts = [
      post('a1', 'ask-share', '2026-09-10'),
      post('a2', 'ask-share', '2026-09-09'),
      post('a3', 'ask-share', '2026-09-08'),
      post('c1', 'conversation', '2026-09-07'),
    ]
    expect(selectShowcasePosts(posts, 4, 2).map((p) => p.id)).toEqual([
      'a1',
      'a2',
      'a3',
      'c1',
    ])
  })

  test('breaks same-day ties toward the later Circle id', () => {
    const posts = [
      post('100', 'lounge', '2026-09-08'),
      post('300', 'conversation', '2026-09-08'),
      post('200', 'ask-share', '2026-09-08'),
    ]
    expect(selectShowcasePosts(posts, 3, 2).map((p) => p.id)).toEqual([
      '300',
      '200',
      '100',
    ])
  })

  test('never exceeds the limit, and tolerates an empty community', () => {
    expect(selectShowcasePosts([], 6, 2)).toEqual([])
    const many = Array.from({ length: 20 }, (_, i) =>
      post(`p${i}`, ['conversation', 'ask-share', 'lounge'][i % 3], '2026-09-01'),
    )
    expect(selectShowcasePosts(many, 6, 2)).toHaveLength(6)
  })

  test('does not mutate its input', () => {
    const posts = [
      post('a', 'ask-share', '2026-09-01'),
      post('b', 'lounge', '2026-09-09'),
    ]
    const before = posts.map((p) => p.id)
    selectShowcasePosts(posts, 2, 1)
    expect(posts.map((p) => p.id)).toEqual(before)
  })
})
