// Unit tests for the pure FAQ validation/sanitization helpers. DB accessors
// (list/create/update/delete) run against the real DB, not here.

import { describe, test, expect } from 'bun:test'
import { sanitizeFaqAnswer, sanitizeQuestion, validateFaqInput } from './faqs'

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
