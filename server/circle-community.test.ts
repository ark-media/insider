/// <reference types="bun" />
// Projection unit tests for the /community Circle reads. The HTTP/pagination
// wiring is covered in routes/circle.test.ts; here we pin the field mapping,
// the format derivation, the HTML→excerpt strip, the SSO deep-link wrapping,
// and the drop/keep rules — all pure, no network.

import { describe, test, expect } from 'bun:test'
import {
  isPublishedFeedPost,
  projectEvent,
  projectFeedPost,
  projectSpaces,
} from './circle-community.js'

describe('projectEvent', () => {
  const base = {
    id: 1,
    name: 'Coalition Roundtable',
    slug: 'coalition-roundtable',
    starts_at: '2026-06-07T19:00:00.000Z',
    duration_in_seconds: 3600,
    location_type: 'live_room',
    host: 'Noa',
    url: 'https://thefold.arkmedia.org/c/events-71d23b/coalition-roundtable',
  }

  test('maps fields and derives a live-room format + label', () => {
    const ev = projectEvent(base)!
    expect(ev.id).toBe('coalition-roundtable')
    expect(ev.title).toBe('Coalition Roundtable')
    expect(ev.startsAt).toBe('2026-06-07T19:00:00.000Z')
    expect(ev.durationMinutes).toBe(60)
    expect(ev.format).toBe('audio-room')
    expect(ev.formatLabel).toBe('Live room')
    expect(ev.hosts).toEqual(['Noa'])
  })

  test('deep-links straight to the real Circle event url', () => {
    const ev = projectEvent(base)!
    expect(ev.deepLink).toBe(base.url)
  })

  test('maps in_person events to the in-person format + venue', () => {
    const ev = projectEvent({
      ...base,
      location_type: 'in_person',
      in_person_location: '92NY, New York',
    })!
    expect(ev.format).toBe('in-person')
    expect(ev.location).toBe('in-person')
    expect(ev.venue).toBe('92NY, New York')
  })

  test('returns null when id or start time is missing/unparseable', () => {
    expect(projectEvent({ ...base, id: undefined })).toBeNull()
    expect(projectEvent({ ...base, starts_at: undefined })).toBeNull()
    expect(projectEvent({ ...base, starts_at: 'not-a-date' })).toBeNull()
  })
})

describe('projectFeedPost', () => {
  const base = {
    id: 42,
    name: 'Inside Mossad’s Shadow War',
    slug: 'inside-mossad',
    body: '<p>The current Iran War is just one chapter in a much longer war.</p>',
    published_at: '2026-04-23T16:17:49.983Z',
    status: 'published',
    user_name: 'Ava',
    space_name: 'Exclusive Ark+ Content',
    url: 'https://thefold.arkmedia.org/c/conversation/inside-mossad',
  }

  test('projects title/author/role + plain-text excerpt + Circle href', () => {
    const item = projectFeedPost(base)!
    expect(item.id).toBe('42')
    expect(item.title).toBe('Inside Mossad’s Shadow War')
    expect(item.authorName).toBe('Ava')
    expect(item.authorRole).toBe('Exclusive Ark+ Content')
    expect(item.excerpt).toBe(
      'The current Iran War is just one chapter in a much longer war.',
    )
    expect(item.excerpt).not.toContain('<p>') // HTML stripped
    expect(item.href).toBe(base.url)
  })

  test('accepts the rich_text {body} body shape', () => {
    const item = projectFeedPost({
      ...base,
      body: { body: '<p>Rich text body.</p>' },
    })!
    expect(item.excerpt).toBe('Rich text body.')
  })

  test('returns null without a publish date', () => {
    expect(
      projectFeedPost({ ...base, published_at: undefined, created_at: undefined }),
    ).toBeNull()
  })
})

describe('isPublishedFeedPost', () => {
  test('rejects non-published status and dateless posts', () => {
    expect(isPublishedFeedPost({ status: 'draft', published_at: '2026-01-01' })).toBe(false)
    expect(isPublishedFeedPost({ status: 'published' })).toBe(false)
    expect(isPublishedFeedPost({ published_at: '2026-01-01' })).toBe(true)
  })
})

describe('projectSpaces', () => {
  const records = [
    { id: 1, slug: 'events-71d23b', name: 'Virtual Events', space_type: 'event' },
    { id: 2, slug: 'ark-code-of-conduct', name: 'Community Guidelines', space_type: 'basic' },
    { id: 3, slug: 'start-here', name: 'Welcome!', space_type: 'basic' },
    { id: 4, slug: 'introduce-yourself', name: 'Introduce Yourself', space_type: 'basic' },
    { id: 5, slug: 'world', name: 'World', space_type: 'basic', url: 'https://thefold.arkmedia.org/c/world' },
    { id: 6, slug: 'life', name: 'Life', space_type: 'basic' },
  ]

  test('excludes system + event spaces, keeps member-facing ones', () => {
    const spaces = projectSpaces(records)
    expect(spaces.map((s) => s.id)).toEqual(['world', 'life'])
  })

  test('uses the real space url, falls back to /c/<slug>', () => {
    const spaces = projectSpaces(records)
    const world = spaces.find((s) => s.id === 'world')!
    const life = spaces.find((s) => s.id === 'life')!
    expect(world.href).toBe('https://thefold.arkmedia.org/c/world')
    expect(life.href).toBe('https://thefold.arkmedia.org/c/life')
  })
})
