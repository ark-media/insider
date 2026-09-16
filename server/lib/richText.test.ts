// Unit tests for the shared rich-text sanitizer — the single authoritative
// boundary behind every admin editor (FAQ answers, job descriptions,
// announcement bodies). The per-surface wrappers (sanitizeFaqAnswer etc.) all
// delegate here, so these assertions cover the contract for all three.

import { describe, test, expect } from 'bun:test'
import { sanitizeRichText, RICH_TEXT_ALLOWED_TAGS } from './richText'

describe('sanitizeRichText', () => {
  test('keeps the full block + inline formatting set', () => {
    const out = sanitizeRichText(
      '<h2>Title</h2><h3>Sub</h3><p>Hi <strong>there</strong> <em>now</em></p>' +
        '<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote>',
    )
    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<h3>Sub</h3>')
    expect(out).toContain('<p>Hi <strong>there</strong> <em>now</em></p>')
    expect(out).toContain('<li>a</li>')
    expect(out).toContain('<ol><li>b</li></ol>')
    expect(out).toContain('<blockquote>q</blockquote>')
  })

  test('preserves line breaks', () => {
    expect(sanitizeRichText('one<br>two')).toContain('<br />')
    expect(sanitizeRichText('<p>a</p><p>b</p>')).toBe('<p>a</p><p>b</p>')
  })

  test('strips scripts, styles, images and unknown tags', () => {
    const out = sanitizeRichText(
      '<script>alert(1)</script><style>x</style><img src=x onerror=alert(1)><div>d</div><p>ok</p>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<style')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<div')
    expect(out).toContain('<p>ok</p>')
  })

  test('forces links to open safely and drops unsafe schemes', () => {
    const safe = sanitizeRichText('<a href="https://x.com">x</a>')
    expect(safe).toContain('target="_blank"')
    expect(safe).toContain('rel="noopener noreferrer"')
    expect(sanitizeRichText('<a href="mailto:a@b.com">m</a>')).toContain('href="mailto:a@b.com"')
    expect(sanitizeRichText('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
  })

  test('allowlist matches the documented tag set', () => {
    expect(RICH_TEXT_ALLOWED_TAGS).toEqual([
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a',
      'ul', 'ol', 'li', 'h2', 'h3', 'h4', 'blockquote',
    ])
  })
})
