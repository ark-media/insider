// The CSP report sink is a public POST that writes to the logs, so what's
// pinned here is mostly what it REFUSES to do: log a credential that rode in on
// a document-uri, let a crafted value forge a second log line, buffer a large
// body, or answer with anything a caller could use.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { makeFakeReq, makeFakeRes } from '../test-utils'
import { cspReportRoutes, parseCspReports } from './csp-report'

const LEGACY = {
  'csp-report': {
    'document-uri': 'https://ark-plus.xyz/redeem?mt=SECRETTOKEN#frag',
    'blocked-uri': 'https://evil.example/x.js?cb=1',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'source-file': 'https://ark-plus.xyz/assets/index.js?v=2',
    'line-number': 42,
  },
}

const REPORTING_API = [
  {
    type: 'csp-violation',
    url: 'https://ark-plus.xyz/shows',
    body: {
      documentURL: 'https://ark-plus.xyz/shows?email=a%40b.com',
      blockedURL: 'https://cdn.example/audio.mp3',
      effectiveDirective: 'media-src',
      sourceFile: null,
      lineNumber: null,
      disposition: 'report',
    },
  },
  { type: 'deprecation', body: { id: 'something-else' } },
]

function post(opts: {
  body?: unknown
  contentType?: string
  method?: string
  ip?: string
}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: '/api/csp-report',
    headers: { 'content-type': opts.contentType ?? 'application/csp-report' },
    body: opts.body,
    remoteAddress: opts.ip,
  })
}

// Fresh route set per call so the per-instance limiter starts empty.
function handler() {
  return cspReportRoutes().find((r) => r.path === '/api/csp-report')!.handler
}

let warn: ReturnType<typeof spyOn>
beforeEach(() => {
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  warn.mockRestore()
})

const logged = () => warn.mock.calls.map((c: unknown[]) => String(c[0]))

describe('parseCspReports', () => {
  test('reads the legacy report-uri shape and drops query strings', () => {
    expect(parseCspReports(LEGACY)).toEqual([
      {
        blocked: 'https://evil.example/x.js',
        directive: 'script-src-elem',
        document: 'https://ark-plus.xyz/redeem',
        source: 'https://ark-plus.xyz/assets/index.js',
        line: '42',
      },
    ])
  })

  test('reads a Reporting API batch and ignores non-CSP report types', () => {
    expect(parseCspReports(REPORTING_API)).toEqual([
      {
        blocked: 'https://cdn.example/audio.mp3',
        directive: 'media-src',
        document: 'https://ark-plus.xyz/shows',
        source: '-',
        line: '-',
      },
    ])
  })

  test('keeps the bare keywords browsers send instead of a URL', () => {
    const [line] = parseCspReports({
      'csp-report': { 'blocked-uri': 'inline', 'violated-directive': 'style-src-elem' },
    })
    expect(line?.blocked).toBe('inline')
    expect(line?.directive).toBe('style-src-elem')
  })

  test('strips control characters and truncates, so a value cannot forge a log line', () => {
    const [line] = parseCspReports({
      'csp-report': {
        'blocked-uri': 'https://x.example/a\n[csp-report] blocked=forged',
        'violated-directive': 'x'.repeat(5000),
      },
    })
    expect(line?.blocked).not.toContain('\n')
    expect(line?.blocked).not.toContain(' ')
    expect(line?.directive.length).toBe(200)
  })

  test('drops violations caused by browser extensions', () => {
    expect(
      parseCspReports({
        'csp-report': {
          'blocked-uri': 'inline',
          'source-file': 'chrome-extension://abcdef/content.js',
          'violated-directive': 'script-src',
        },
      }),
    ).toEqual([])
  })

  test('caps how many reports one request can log', () => {
    const batch = Array.from({ length: 50 }, () => REPORTING_API[0])
    expect(parseCspReports(batch).length).toBe(5)
  })

  test('yields nothing for payloads that are not CSP reports', () => {
    for (const junk of [null, 'x', 7, {}, [], { 'csp-report': 'nope' }, [null, 3]]) {
      expect(parseCspReports(junk)).toEqual([])
    }
  })
})

describe('POST /api/csp-report', () => {
  test('logs one greppable line, answers 204 with no body, and never logs the token', async () => {
    const res = makeFakeRes()
    await handler()(post({ body: LEGACY }), res)

    expect(res.statusCode).toBe(204)
    expect(res.__body()).toBe('')
    expect(logged()).toEqual([
      '[csp-report] blocked=https://evil.example/x.js directive=script-src-elem ' +
        'document=https://ark-plus.xyz/redeem source=https://ark-plus.xyz/assets/index.js line=42',
    ])
    expect(logged().join('\n')).not.toContain('SECRETTOKEN')
  })

  test('accepts the Reporting API content type (with a charset parameter)', async () => {
    const res = makeFakeRes()
    await handler()(
      post({ body: REPORTING_API, contentType: 'application/reports+json; charset=utf-8' }),
      res,
    )
    expect(res.statusCode).toBe(204)
    expect(logged().length).toBe(1)
    expect(logged()[0]).toContain('directive=media-src')
    expect(logged()[0]).not.toContain('email')
  })

  test('malformed JSON is swallowed: 204, nothing logged, nothing echoed', async () => {
    const res = makeFakeRes()
    await handler()(post({ body: '{not json <script>' }), res)
    expect(res.statusCode).toBe(204)
    expect(res.__body()).toBe('')
    expect(logged()).toEqual([])
  })

  test('rejects other content types with a bare 415', async () => {
    const res = makeFakeRes()
    await handler()(post({ body: 'a=b', contentType: 'text/plain' }), res)
    expect(res.statusCode).toBe(415)
    expect(res.__body()).toBe('')
    expect(logged()).toEqual([])
  })

  test('rejects a body over the 16 KiB cap with a bare 413', async () => {
    const res = makeFakeRes()
    const big = { 'csp-report': { 'blocked-uri': 'x'.repeat(17 * 1024) } }
    await handler()(post({ body: big }), res)
    expect(res.statusCode).toBe(413)
    expect(res.__body()).toBe('')
    expect(logged()).toEqual([])
  })

  test('only POST is allowed', async () => {
    const res = makeFakeRes()
    await handler()(post({ method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
  })

  test('rate-limits per IP without touching other clients', async () => {
    const h = handler()
    let last = makeFakeRes()
    for (let i = 0; i < 21; i++) {
      last = makeFakeRes()
      await h(post({ body: LEGACY, ip: '203.0.113.9' }), last)
    }
    expect(last.statusCode).toBe(429)
    expect(last.__headers()['retry-after']).toBeDefined()
    expect(last.__body()).toBe('')

    const other = makeFakeRes()
    await h(post({ body: LEGACY, ip: '203.0.113.10' }), other)
    expect(other.statusCode).toBe(204)
  })
})
