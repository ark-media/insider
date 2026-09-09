// Unit tests for the pure FAQ validation/sanitization helpers. DB accessors
// (list/create/update/delete) run against the real DB, not here.

import { describe, test, expect } from 'bun:test'
import type { Sql } from './db.js'
import {
  createFaq,
  DuplicateFaqKeyError,
  sanitizeFaqAnswer,
  sanitizeQuestion,
  updateFaq,
  validateFaqInput,
} from './faqs'

const valid = {
  question: 'Can I listen for free?',
  answer: '<p>Yes! The feed is free.</p>',
}

describe('sanitizeFaqAnswer', () => {
  test('keeps paragraphs, lists, inline formatting and links', () => {
    const out = sanitizeFaqAnswer(
      '<p>Hi <strong>there</strong></p><ul><li>one</li></ul><a href="https://x.com">x</a>',
    )
    expect(out).toContain('<p>')
    expect(out).toContain('<strong>')
    expect(out).toContain('<li>one</li>')
    expect(out).toContain('href="https://x.com"')
  })
  test('forces links to open safely in a new tab', () => {
    const out = sanitizeFaqAnswer('<a href="https://x.com">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
  test('allows mailto links', () => {
    const out = sanitizeFaqAnswer('<a href="mailto:help@x.com">help</a>')
    expect(out).toContain('href="mailto:help@x.com"')
  })
  test('keeps headings, strips scripts and unknown tags', () => {
    const out = sanitizeFaqAnswer(
      '<h2>Title</h2><script>alert(1)</script><div>x</div><p>ok</p>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<div')
    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<p>ok</p>')
  })
  test('drops javascript: URLs', () => {
    const out = sanitizeFaqAnswer('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain('javascript:')
  })
})

describe('sanitizeQuestion', () => {
  test('strips all markup to plain text', () => {
    expect(sanitizeQuestion('<b>Hi</b> <script>x</script>there')).toBe('Hi there')
  })
})

describe('validateFaqInput', () => {
  test('accepts a valid FAQ and defaults enabled/order', () => {
    const r = validateFaqInput(valid)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.question).toBe('Can I listen for free?')
      expect(r.value.answer).toContain('<p>')
      expect(r.value.enabled).toBe(true)
      expect(r.value.displayOrder).toBe(0)
    }
  })
  test('rejects a missing question', () => {
    const r = validateFaqInput({ ...valid, question: '   ' })
    expect(r.ok).toBe(false)
  })
  test('rejects a missing answer', () => {
    const r = validateFaqInput({ ...valid, answer: '' })
    expect(r.ok).toBe(false)
  })
  test('rejects an answer with no visible text after sanitizing', () => {
    const r = validateFaqInput({ ...valid, answer: '<script>alert(1)</script>' })
    expect(r.ok).toBe(false)
  })
  test('rejects a non-integer display order', () => {
    const r = validateFaqInput({ ...valid, displayOrder: 1.5 })
    expect(r.ok).toBe(false)
  })
  test('defaults category to empty string and strips markup', () => {
    const plain = validateFaqInput(valid)
    expect(plain.ok).toBe(true)
    if (plain.ok) expect(plain.value.category).toBe('')

    const tagged = validateFaqInput({ ...valid, category: '<b>Choosing</b> a Plan' })
    expect(tagged.ok).toBe(true)
    if (tagged.ok) expect(tagged.value.category).toBe('Choosing a Plan')
  })
  test('coerces enabled to a strict boolean', () => {
    const r = validateFaqInput({ ...valid, enabled: 'yes' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.enabled).toBe(false)
  })
  test('rejects a non-object body', () => {
    expect(validateFaqInput(null).ok).toBe(false)
    expect(validateFaqInput('nope').ok).toBe(false)
  })
})

describe('validateFaqInput — key', () => {
  const ok = (raw: unknown) => {
    const r = validateFaqInput(raw)
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
    return r.value
  }

  test('absent or blank becomes null, so the unique index ignores it', () => {
    expect(ok(valid).key).toBeNull()
    expect(ok({ ...valid, key: '   ' }).key).toBeNull()
  })

  test('accepts a slug and lowercases it', () => {
    expect(ok({ ...valid, key: 'cancel-anytime' }).key).toBe('cancel-anytime')
    expect(ok({ ...valid, key: '  Cancel-Anytime  ' }).key).toBe('cancel-anytime')
  })

  test('rejects anything that is not a clean slug', () => {
    for (const key of ['has space', 'under_score', 'trailing-', '-leading', 'double--hyphen', 'punct!']) {
      const r = validateFaqInput({ ...valid, key })
      expect(r.ok).toBe(false)
    }
  })

  // The admin editor PUTs the whole record, so a form that forgot to carry the
  // key would silently clear it and break every widget topic bound to that row.
  // This asserts the shape the editor must send, not just what validates.
  test('a full-replace draft round-trips its key', () => {
    const draft = { ...valid, key: 'where-am-i-subscribed', category: 'Account', enabled: true, displayOrder: 22 }
    expect(ok(draft).key).toBe('where-am-i-subscribed')
  })
})

/**
 * The one write failure an editor can fix from the form.
 *
 * `faqs_key_idx` is unique, and uniqueness can't be validated up front without
 * a race, so the collision has to be caught where Postgres reports it.
 * Uncaught, 23505 propagated to the route's catch-all and came back as
 * `internal_error` — a generic failure shown next to the key that caused it,
 * with nothing to say the key was the problem.
 */
describe('duplicate keys', () => {
  const input = {
    key: 'cancel-anytime',
    question: 'Q',
    answer: '<p>A</p>',
    category: '',
    enabled: true,
    displayOrder: 0,
  }

  /** A `Sql` that fails the way the Neon driver does on a unique violation. */
  function failingSql(err: unknown): Sql {
    const sql = (() => Promise.reject(err)) as unknown as Sql
    ;(sql as unknown as { unsafe: (s: string) => string }).unsafe = (s) => s
    return sql
  }

  const violation = { code: '23505', constraint_name: 'faqs_key_idx' }

  test('createFaq reports the collision, and names the key', async () => {
    const err = await createFaq(failingSql(violation), input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DuplicateFaqKeyError)
    expect((err as DuplicateFaqKeyError).key).toBe('cancel-anytime')
  })

  test('updateFaq reports it too', async () => {
    const err = await updateFaq(failingSql(violation), 'some-id', input).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(DuplicateFaqKeyError)
  })

  test('a row with no key cannot have collided, so the error passes through', async () => {
    const err = await createFaq(failingSql(violation), { ...input, key: null }).catch(
      (e: unknown) => e,
    )
    expect(err).not.toBeInstanceOf(DuplicateFaqKeyError)
  })

  test('any other failure is left alone rather than mislabelled', async () => {
    const other = { code: '08006' } // connection failure
    const err = await createFaq(failingSql(other), input).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(DuplicateFaqKeyError)
    expect(err).toBe(other)
  })
})
