// Open House config: what the public page is allowed to show, and what the
// admin PUT is allowed to store.

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_OPEN_HOUSE_CONFIG,
  OPEN_HOUSE_DISPLAY_LIMIT,
  upcomingOpenHouses,
  validateOpenHouseConfig,
  type OpenHouseConfig,
  type OpenHouseSession,
} from './open-house'

const NOW = Date.parse('2026-10-14T12:00:00Z')

function session(over: Partial<OpenHouseSession> = {}): OpenHouseSession {
  return {
    id: over.id ?? 'a',
    startsAt: over.startsAt ?? '2026-10-21T16:00:00.000Z',
    durationMinutes: over.durationMinutes ?? 45,
    ...(over.rsvpUrl ? { rsvpUrl: over.rsvpUrl } : {}),
    ...(over.note ? { note: over.note } : {}),
  }
}

function config(sessions: OpenHouseSession[], enabled = true): OpenHouseConfig {
  return { enabled, sessions }
}

describe('upcomingOpenHouses', () => {
  test('drops sessions that have already ended', () => {
    const over = session({ id: 'over', startsAt: '2026-10-14T10:00:00Z', durationMinutes: 45 })
    const next = session({ id: 'next' })
    expect(upcomingOpenHouses(config([over, next]), NOW).map((s) => s.id)).toEqual([
      'next',
    ])
  })

  test('keeps a session that is under way — the late arrival still wants it', () => {
    const live = session({
      id: 'live',
      startsAt: '2026-10-14T11:45:00Z',
      durationMinutes: 45,
    })
    expect(upcomingOpenHouses(config([live]), NOW).map((s) => s.id)).toEqual(['live'])
  })

  test('sorts soonest first, whatever order they were stored in', () => {
    const later = session({ id: 'later', startsAt: '2026-11-04T16:00:00Z' })
    const sooner = session({ id: 'sooner', startsAt: '2026-10-21T16:00:00Z' })
    expect(
      upcomingOpenHouses(config([later, sooner]), NOW).map((s) => s.id),
    ).toEqual(['sooner', 'later'])
  })

  test('caps the list at the display limit', () => {
    const many = Array.from({ length: OPEN_HOUSE_DISPLAY_LIMIT + 3 }, (_, i) =>
      session({ id: `s${i}`, startsAt: `2026-11-0${i + 1}T16:00:00Z` }),
    )
    expect(upcomingOpenHouses(config(many), NOW)).toHaveLength(
      OPEN_HOUSE_DISPLAY_LIMIT,
    )
  })

  test('disabled shows nothing, however much is scheduled', () => {
    expect(upcomingOpenHouses(config([session()], false), NOW)).toEqual([])
  })

  test('an unparseable date is skipped rather than throwing', () => {
    const bad = { ...session({ id: 'bad' }), startsAt: 'not a date' }
    const good = session({ id: 'good' })
    expect(upcomingOpenHouses(config([bad, good]), NOW).map((s) => s.id)).toEqual([
      'good',
    ])
  })
})

describe('validateOpenHouseConfig', () => {
  test('accepts and normalizes a well-formed config', () => {
    const v = validateOpenHouseConfig({
      enabled: true,
      sessions: [
        {
          id: 'a',
          startsAt: '2026-10-21T16:00:00Z',
          durationMinutes: 45,
          rsvpUrl: '  https://zoom.us/j/123  ',
          note: '  Evening session  ',
        },
      ],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.value.sessions[0]).toEqual({
      id: 'a',
      startsAt: '2026-10-21T16:00:00.000Z',
      durationMinutes: 45,
      rsvpUrl: 'https://zoom.us/j/123',
      note: 'Evening session',
    })
  })

  test('a session with no RSVP link is allowed — a date can precede the meeting', () => {
    const v = validateOpenHouseConfig({
      enabled: true,
      sessions: [{ id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45 }],
    })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.value.sessions[0].rsvpUrl).toBeUndefined()
  })

  test('an empty schedule is valid — it just hides the section', () => {
    expect(validateOpenHouseConfig({ enabled: true, sessions: [] }).ok).toBe(true)
  })

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>',
    'not a url at all',
  ])('rejects a non-http(s) RSVP link: %s', (rsvpUrl) => {
    const v = validateOpenHouseConfig({
      enabled: true,
      sessions: [
        { id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45, rsvpUrl },
      ],
    })
    expect(v.ok).toBe(false)
  })

  test('rejects a duplicate id — it would collide as a React key', () => {
    const one = { id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45 }
    const v = validateOpenHouseConfig({ enabled: true, sessions: [one, { ...one }] })
    expect(v.ok).toBe(false)
  })

  test.each([
    ['a missing date', { id: 'a', durationMinutes: 45 }],
    ['an unreadable date', { id: 'a', startsAt: 'soon', durationMinutes: 45 }],
    ['a missing id', { startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45 }],
    ['a zero length', { id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 0 }],
    [
      'a fractional length',
      { id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45.5 },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(validateOpenHouseConfig({ enabled: true, sessions: [raw] }).ok).toBe(false)
  })

  test('the error names which session is wrong', () => {
    const ok = { id: 'a', startsAt: '2026-10-21T16:00:00Z', durationMinutes: 45 }
    const v = validateOpenHouseConfig({
      enabled: true,
      sessions: [ok, { ...ok, id: 'b', durationMinutes: 0 }],
    })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.error).toContain('Session 2')
  })

  test.each([
    ['a non-object', 'nope'],
    ['a missing enabled flag', { sessions: [] }],
    ['sessions that are not a list', { enabled: true, sessions: {} }],
  ])('rejects %s', (_label, raw) => {
    expect(validateOpenHouseConfig(raw).ok).toBe(false)
  })

  test('the shipped default survives its own validator', () => {
    expect(validateOpenHouseConfig(DEFAULT_OPEN_HOUSE_CONFIG).ok).toBe(true)
  })
})
