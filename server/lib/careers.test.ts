// Unit tests for the pure careers validation/sanitization helpers. DB accessors
// (list/get/create/update/delete) run against the real DB, not here.

import { describe, test, expect } from 'bun:test'
import {
  slugify,
  normalizeApplyUrl,
  sanitizeCareerDescription,
  validateCareerInput,
} from './careers'

const valid = {
  title: 'Senior Producer',
  summary: 'Lead production across the portfolio.',
  description: '<h2>About</h2><p>Do great work.</p>',
}

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    expect(slugify('History Podcast Co-Host')).toBe('history-podcast-co-host')
    expect(slugify('  Senior   Producer!! ')).toBe('senior-producer')
  })
  test('strips leading/trailing separators', () => {
    expect(slugify('--Hello--')).toBe('hello')
    expect(slugify('***')).toBe('')
  })
})

describe('sanitizeCareerDescription', () => {
  test('keeps block tags, lists and links', () => {
    const out = sanitizeCareerDescription('<h2>Role</h2><ul><li>x</li></ul><a href="/x">y</a>')
    expect(out).toContain('<h2>Role</h2>')
    expect(out).toContain('<li>x</li>')
    expect(out).toContain('href="/x"')
  })
  test('strips script/style/img and forces safe links', () => {
    expect(sanitizeCareerDescription('<script>alert(1)</script><p>Hi</p>')).toBe('<p>Hi</p>')
    expect(sanitizeCareerDescription('<img src=x onerror=alert(1)>Hi')).toBe('Hi')
    const link = sanitizeCareerDescription('<a href="https://x.com">x</a>')
    expect(link).toContain('target="_blank"')
    expect(link).toContain('rel="noopener noreferrer"')
  })
})

describe('normalizeApplyUrl', () => {
  test('empty/null becomes null', () => {
    expect(normalizeApplyUrl('')).toBeNull()
    expect(normalizeApplyUrl(null)).toBeNull()
    expect(normalizeApplyUrl('   ')).toBeNull()
  })
  test('keeps http(s) and mailto', () => {
    expect(normalizeApplyUrl('https://app.testgorilla.com/s/n7y6e4s3')).toBe(
      'https://app.testgorilla.com/s/n7y6e4s3',
    )
    expect(normalizeApplyUrl('mailto:careers@ark.com')).toBe('mailto:careers@ark.com')
  })
  test('rejects relative paths, javascript:, and garbage', () => {
    expect(normalizeApplyUrl('/careers')).toEqual({ error: expect.any(String) })
    expect(normalizeApplyUrl('javascript:alert(1)')).toEqual({ error: expect.any(String) })
    expect(normalizeApplyUrl('not a url')).toEqual({ error: expect.any(String) })
  })
})

describe('validateCareerInput', () => {
  test('requires an object', () => {
    expect(validateCareerInput(null).ok).toBe(false)
    expect(validateCareerInput('x').ok).toBe(false)
  })
  test('requires title, summary, and visible description', () => {
    expect(validateCareerInput({ ...valid, title: '' }).ok).toBe(false)
    expect(validateCareerInput({ ...valid, summary: '   ' }).ok).toBe(false)
    expect(validateCareerInput({ ...valid, description: '<p></p>' }).ok).toBe(false)
  })
  test('derives slug from title when omitted', () => {
    const r = validateCareerInput(valid)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.slug).toBe('senior-producer')
  })
  test('re-normalizes a provided slug', () => {
    const r = validateCareerInput({ ...valid, slug: 'History Host!' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.slug).toBe('history-host')
  })
  test('applies defaults and sanitizes', () => {
    const r = validateCareerInput({
      ...valid,
      description: '<script>x</script><h2>About</h2>',
      summary: '<b>Lead</b> the team',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.enabled).toBe(true)
      expect(r.value.displayOrder).toBe(0)
      expect(r.value.applyUrl).toBeNull()
      expect(r.value.description).toBe('<h2>About</h2>')
      expect(r.value.summary).toBe('Lead the team')
    }
  })
  test('rejects a bad apply URL and non-integer order', () => {
    expect(validateCareerInput({ ...valid, applyUrl: 'not a url' }).ok).toBe(false)
    expect(validateCareerInput({ ...valid, displayOrder: 1.5 }).ok).toBe(false)
  })
})
