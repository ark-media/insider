// The UPDATE behind survey-after-cancel.
//
// What the member checked is attached to a row that already exists, so the
// `where` clause decides whose reasons ever get stored. It carried a second
// clause — offer_outcome in ('declined','not_offered') — that silently dropped
// the reasons of anyone whose row was written 'accepted'. That is exactly the
// debundler who took the intro rate: their row is 'accepted' so the coupon
// spends the retention window, and they are the whole population the debundle
// survey asks. These pin the guard that remains (the member's own email) and
// the one that must not come back.

import { describe, test, expect } from 'bun:test'
import { updateCancellationSurveyReasons } from './lib/cancellation'
import type { Sql } from './lib/db'

// Captures the tagged-template query as text + bound values, the way the Neon
// client would receive it. `?` marks each interpolation.
function captureSql() {
  const calls: { text: string; values: unknown[] }[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values })
    return Promise.resolve([])
  }) as unknown as Sql
  return { sql, calls }
}

const input = {
  id: 7,
  email: 'member@example.com',
  reasons: ['fold_overwhelming'],
  note: null,
}

describe('updateCancellationSurveyReasons', () => {
  test('scopes the update to the row AND the member who owns it', async () => {
    const { sql, calls } = captureSql()
    await updateCancellationSurveyReasons(sql, input)
    expect(calls).toHaveLength(1)
    const { text, values } = calls[0]
    expect(text).toContain('update cancellation_survey')
    expect(text).toContain('where id =')
    expect(text).toContain('and email =')
    // reasons, note, id, email — in the order they appear in the statement.
    expect(values).toEqual([['fold_overwhelming'], null, 7, 'member@example.com'])
  })

  test('does not filter by offer_outcome', async () => {
    // A debundler who took the intro rate has an 'accepted' row. Re-adding this
    // clause would make their survey a silent no-op: the endpoint still answers
    // 200, and nothing is written.
    const { sql, calls } = captureSql()
    await updateCancellationSurveyReasons(sql, input)
    expect(calls[0].text).not.toContain('offer_outcome')
  })
})
