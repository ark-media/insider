// The per-newsletter thread cache must not let a query that started before an
// admin write put its pre-write result back after the write cleared the cache.

import { describe, test, expect } from 'bun:test'
import type { Sql } from './db'
import { deleteDiscussThread, listDiscussThreadsByNewsletterCached } from './discuss-threads'

const row = (id: string) => ({
  id,
  newsletter_slug: 'ark-daily',
  beehiiv_post_id: `post_${id}`,
  beehiiv_post_title: `Post ${id}`,
  circle_thread_url: `https://circle.example/${id}`,
  circle_space_id: 1,
  circle_post_id: 2,
  beehiiv_body_patched: true,
  created_at: new Date('2026-09-01T00:00:00Z'),
})

// Each select waits on its own deferred so the test controls when it lands.
function fakeSql() {
  const selects: { resolve: (rows: unknown[]) => void }[] = []
  const sql = ((strings: TemplateStringsArray) => {
    const text = strings.join('?')
    if (text.includes('delete from discuss_threads')) return Promise.resolve([{ id: 'x' }])
    return new Promise((resolve) => selects.push({ resolve }))
  }) as unknown as Sql
  return { sql, selects }
}

describe('listDiscussThreadsByNewsletterCached', () => {
  test('a write during an in-flight load is not undone by that load', async () => {
    const { sql, selects } = fakeSql()

    const stale = listDiscussThreadsByNewsletterCached(sql, 'ark-daily')
    await Promise.resolve()
    expect(selects).toHaveLength(1)

    await deleteDiscussThread(sql, 'x')

    // A read after the write starts its own query rather than joining the old one.
    const fresh = listDiscussThreadsByNewsletterCached(sql, 'ark-daily')
    await Promise.resolve()
    expect(selects).toHaveLength(2)

    selects[0].resolve([row('old')])
    expect((await stale).map((t) => t.id)).toEqual(['old'])
    selects[1].resolve([row('new')])
    expect((await fresh).map((t) => t.id)).toEqual(['new'])

    // The cache holds the post-write result, not the pre-write one.
    const again = await listDiscussThreadsByNewsletterCached(sql, 'ark-daily')
    expect(again.map((t) => t.id)).toEqual(['new'])
    expect(selects).toHaveLength(2)
  })

  test('the pre-write load alone does not refill the cache', async () => {
    const { sql, selects } = fakeSql()
    await deleteDiscussThread(sql, 'x') // start from an empty cache

    const stale = listDiscussThreadsByNewsletterCached(sql, 'ark-daily')
    await Promise.resolve()
    await deleteDiscussThread(sql, 'x')
    selects[0].resolve([row('old')])
    await stale

    const next = listDiscussThreadsByNewsletterCached(sql, 'ark-daily')
    await Promise.resolve()
    expect(selects).toHaveLength(2)
    selects[1].resolve([row('new')])
    expect((await next).map((t) => t.id)).toEqual(['new'])
  })
})
