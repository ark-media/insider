// Unit tests for the pure announcement validation/sanitization helpers. The
// active-window selection lives in SQL (getActiveAnnouncement) and is exercised
// against the real DB, not here.

import { describe, test, expect } from 'bun:test'
import {
  isHexColor,
  normalizeActionUrl,
  sanitizeAnnouncementBody,
  validateAnnouncementInput,
  DEFAULT_BAR_COLOR,
  DEFAULT_TEXT_COLOR,
} from './announcements'

const valid = {
  body: 'Save now',
  startsAt: '2026-05-01T00:00:00Z',
  endsAt: '2026-05-31T23:59:00Z',
}

describe('sanitizeAnnouncementBody', () => {
  test('keeps inline formatting and links', () => {
    expect(sanitizeAnnouncementBody('<b>Save</b> <a href="/plus">now</a>')).toContain('<b>Save</b>')
    expect(sanitizeAnnouncementBody('<a href="/plus">now</a>')).toContain('href="/plus"')
  })
  test('strips scripts but keeps block formatting', () => {
    expect(sanitizeAnnouncementBody('<script>alert(1)</script>Hello')).toBe('Hello')
    expect(sanitizeAnnouncementBody('<p>Hi</p>')).toBe('<p>Hi</p>')
    expect(sanitizeAnnouncementBody('<ul><li>x</li></ul>')).toContain('<li>x</li>')
  })
  test('adds target/rel to links', () => {
    const out = sanitizeAnnouncementBody('<a href="https://x.com">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
})

describe('isHexColor', () => {
  test('accepts #rrggbb', () => {
    expect(isHexColor('#4a9fe8')).toBe(true)
    expect(isHexColor('#FFFFFF')).toBe(true)
  })
  test('rejects shorthand and names', () => {
    expect(isHexColor('#fff')).toBe(false)
    expect(isHexColor('blue')).toBe(false)
  })
})

describe('normalizeActionUrl', () => {
  test('empty/null becomes null', () => {
    expect(normalizeActionUrl('')).toBeNull()
    expect(normalizeActionUrl(null)).toBeNull()
    expect(normalizeActionUrl('   ')).toBeNull()
  })
  test('relative path is kept', () => {
    expect(normalizeActionUrl('/plus')).toBe('/plus')
  })
  test('http(s) absolute is kept', () => {
    expect(normalizeActionUrl('https://ark.com/x')).toBe('https://ark.com/x')
  })
  test('rejects javascript: and garbage', () => {
    expect(normalizeActionUrl('javascript:alert(1)')).toEqual({ error: expect.any(String) })
    expect(normalizeActionUrl('not a url')).toEqual({ error: expect.any(String) })
  })
  test('rejects protocol-relative URLs that look relative but go off-site', () => {
    expect(normalizeActionUrl('//evil.com')).toEqual({ error: expect.any(String) })
  })
})

describe('validateAnnouncementInput', () => {
  test('requires an object', () => {
    expect(validateAnnouncementInput(null).ok).toBe(false)
    expect(validateAnnouncementInput('x').ok).toBe(false)
  })
  test('requires body with visible text', () => {
    expect(validateAnnouncementInput({ ...valid, body: '' }).ok).toBe(false)
    expect(validateAnnouncementInput({ ...valid, body: '<b></b>' }).ok).toBe(false)
    expect(validateAnnouncementInput({ ...valid, body: '<img src=x>' }).ok).toBe(false)
  })
  test('applies defaults for color/flags', () => {
    const r = validateAnnouncementInput(valid)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.barColor).toBe(DEFAULT_BAR_COLOR)
      expect(r.value.textColor).toBe(DEFAULT_TEXT_COLOR)
      expect(r.value.dismissible).toBe(true)
      expect(r.value.enabled).toBe(true)
      expect(r.value.actionUrl).toBeNull()
    }
  })
  test('rejects bad colors', () => {
    expect(validateAnnouncementInput({ ...valid, barColor: 'red' }).ok).toBe(false)
  })
  test('rejects end <= start', () => {
    expect(
      validateAnnouncementInput({ ...valid, startsAt: '2026-05-31T00:00:00Z', endsAt: '2026-05-01T00:00:00Z' }).ok,
    ).toBe(false)
  })
  test('normalizes dates to ISO and sanitizes body', () => {
    const r = validateAnnouncementInput({
      ...valid,
      body: '<script>x</script><b>Hi</b>',
      actionUrl: '/plus',
      dismissible: false,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.body).toBe('<b>Hi</b>')
      expect(r.value.actionUrl).toBe('/plus')
      expect(r.value.dismissible).toBe(false)
      expect(r.value.startsAt).toBe(new Date(valid.startsAt).toISOString())
    }
  })
})
