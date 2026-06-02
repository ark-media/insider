// Unit tests for the content-notification preferences helper. The helper takes
// `sql` as a parameter, so we pass a fake tagged-template that records calls and
// returns programmed rows — no Neon mock or live DB needed.

import { describe, test, expect } from 'bun:test'
import {
  getContentNotificationPrefs,
  setContentNotificationPrefs,
} from './notification-prefs.js'
import type { Sql } from './db.js'

type Call = { text: string; values: unknown[] }

function fakeSql(rowsFor: (text: string) => unknown[]) {
  const calls: Call[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    calls.push({ text, values })
    return Promise.resolve(rowsFor(text))
  }) as unknown as Sql
  return { sql, calls }
}

describe('getContentNotificationPrefs', () => {
  test('defaults to both on when no row exists', async () => {
    const { sql } = fakeSql(() => [])
    const prefs = await getContentNotificationPrefs(sql, 'a@b.com')
    expect(prefs).toEqual({ episodes: true, posts: true })
  })

  test('returns the stored row values', async () => {
    const { sql, calls } = fakeSql(() => [
      { notify_episodes: false, notify_posts: true },
    ])
    const prefs = await getContentNotificationPrefs(sql, 'A@B.com')
    expect(prefs).toEqual({ episodes: false, posts: true })
    // Email is normalized (lowercased) for the lookup.
    expect(calls[0]?.values[0]).toBe('a@b.com')
  })
})

describe('setContentNotificationPrefs', () => {
  test('merges the patch over current values and upserts', async () => {
    const { sql, calls } = fakeSql((text) =>
      text.includes('select')
        ? [{ notify_episodes: true, notify_posts: true }]
        : [],
    )
    const next = await setContentNotificationPrefs(sql, 'a@b.com', {
      posts: false,
    })
    expect(next).toEqual({ episodes: true, posts: false })

    // One select (read current) then one insert..on conflict (write).
    const insert = calls.find((c) => c.text.includes('insert'))
    expect(insert).toBeDefined()
    // values: email, episodes, posts
    expect(insert?.values).toEqual(['a@b.com', true, false])
  })

  test('keeps both values when patch is partial on the other field', async () => {
    const { sql } = fakeSql((text) =>
      text.includes('select')
        ? [{ notify_episodes: false, notify_posts: false }]
        : [],
    )
    const next = await setContentNotificationPrefs(sql, 'a@b.com', {
      episodes: true,
    })
    expect(next).toEqual({ episodes: true, posts: false })
  })
})
