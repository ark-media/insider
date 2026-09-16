// The back office's session listing, and specifically its `limit`.
//
// DB accessors normally run against the real DB rather than here, but the clamp
// is arithmetic on caller input and it got the arithmetic wrong: a `?limit=` the
// route could not parse arrived as NaN, `Math.trunc(NaN) || 0` collapsed it to
// 0, and the floor turned that into ONE row. The back office then rendered a
// single session and two tallies computed from it — reading as "almost nobody
// has used the help widget" rather than as a bad parameter.

import { describe, expect, test } from 'bun:test'
import type { Sql } from './db.js'
import { SUPPORT_SESSIONS_DEFAULT_LIMIT, listSupportSessions } from './support.js'

/** Records the values interpolated into the query and returns no rows. */
function fakeSql(): { sql: Sql; values: unknown[] } {
  const values: unknown[] = []
  const sql = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    values.push(...vals)
    return Promise.resolve([])
  }) as unknown as Sql
  ;(sql as unknown as { unsafe: (s: string) => string }).unsafe = (s) => s
  return { sql, values }
}

/** The value that actually reached `limit $n`. */
async function limitSentFor(limit?: number): Promise<number> {
  const { sql, values } = fakeSql()
  await (limit === undefined ? listSupportSessions(sql) : listSupportSessions(sql, limit))
  // `sql.unsafe(COLUMNS)` is inlined, so the only interpolated value is the cap.
  return values.at(-1) as number
}

describe('listSupportSessions — limit', () => {
  test('passes a sensible limit straight through', async () => {
    expect(await limitSentFor(25)).toBe(25)
  })

  test('defaults when the caller names no limit', async () => {
    expect(await limitSentFor()).toBe(SUPPORT_SESSIONS_DEFAULT_LIMIT)
  })

  test('a limit it cannot read falls back to the default, not to one row', async () => {
    expect(await limitSentFor(Number.NaN)).toBe(SUPPORT_SESSIONS_DEFAULT_LIMIT)
    expect(await limitSentFor(Number.POSITIVE_INFINITY)).toBe(SUPPORT_SESSIONS_DEFAULT_LIMIT)
  })

  test('still floors a limit that was deliberately too small, and caps a huge one', async () => {
    // 0 and -5 are a caller asking for nothing, which is different from a
    // caller we could not parse: those stay clamped to the floor.
    expect(await limitSentFor(0)).toBe(1)
    expect(await limitSentFor(-5)).toBe(1)
    expect(await limitSentFor(10_000)).toBe(500)
  })

  test('truncates a fractional limit', async () => {
    expect(await limitSentFor(12.9)).toBe(12)
  })
})
