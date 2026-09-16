// Guards the dependency shape behind every server-side sanitizer.
//
// sanitize-html is CommonJS and does a bare `require('htmlparser2')`. From
// 2.17.2 it asks for an htmlparser2 that is ESM-only, and Vercel's function
// loader (/opt/rust/nodejs.js) cannot require() an ES module — every /api
// route 500s at cold start with ERR_REQUIRE_ESM. Node 24 itself supports
// require(esm), so this never reproduces locally or in `bun test`; it only
// shows up once deployed, which is exactly why it needs a test.
//
// The fix is the scoped `sanitize-html>htmlparser2` override in package.json,
// holding that one edge of the graph at the last CommonJS line (9.x) while
// html-react-parser keeps the 12.0.0 it pins exactly. These assertions fail
// the moment the override is dropped or widened.

import { describe, test, expect } from 'bun:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { sanitizeRichText } from './richText'

// The package.json governing a resolved entry file: walk up from the file
// until one turns up. Reading it by subpath is not an option — htmlparser2@12
// has an `exports` map that refuses './package.json'.
function packageJsonFor(entry: string): { name: string; version: string; type?: string } {
  let dir = dirname(entry)
  const { root } = parse(dir)
  while (dir !== root) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name) return pkg
    } catch {
      // keep walking
    }
    dir = dirname(dir)
  }
  throw new Error(`no package.json above ${entry}`)
}

describe('sanitize-html runtime shape', () => {
  test('resolves a CommonJS htmlparser2, so Vercel can require() it', () => {
    const fromHere = createRequire(import.meta.url)
    const fromSanitizeHtml = createRequire(fromHere.resolve('sanitize-html'))
    const pkg = packageJsonFor(fromSanitizeHtml.resolve('htmlparser2'))

    expect(pkg.name).toBe('htmlparser2')
    // "type": "module" is the whole failure: it makes require() throw under
    // Vercel's loader. Absent or "commonjs" is what we need.
    expect(pkg.type ?? 'commonjs').toBe('commonjs')
  })

  test('the sanitizer still works on the version that override pairs it with', () => {
    expect(sanitizeRichText('<p>hi <strong>there</strong></p>')).toBe(
      '<p>hi <strong>there</strong></p>',
    )
    expect(sanitizeRichText('<script>alert(1)</script><p>ok</p>')).toBe('<p>ok</p>')
  })

  test('holds the advisories that motivated the 2.17.7 bump', () => {
    // GHSA-vccv-cmxp-4j9h / GHSA-g8qq-57p8-ggw5 — scheme validation. None of
    // these is http, https or mailto, so the href must be dropped outright.
    for (const href of [
      'javascript:alert(1)',
      'java\tscript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(sanitizeRichText(`<a href="${href}">x</a>`)).not.toContain('href=')
    }
    expect(sanitizeRichText('<a href="https://ark-plus.xyz">x</a>')).toContain(
      'href="https://ark-plus.xyz"',
    )

    // GHSA-jxwj-j7wr-gfrw — the </textarea/> solidus close. textarea is not
    // in any of our allowlists, so the mutation has nothing to break out of.
    expect(sanitizeRichText('<textarea></textarea/><img src=x onerror=alert(1)>')).not.toContain(
      'onerror',
    )
  })
})
