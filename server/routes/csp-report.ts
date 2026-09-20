// CSP violation report sink.
//
//   POST /api/csp-report — public, unauthenticated by necessity: the BROWSER
//     posts here on its own (no cookies we can rely on, no custom headers, no
//     CSRF token), whenever a page breaks the policy in vercel.json. Both wire
//     formats arrive at this one path:
//       - `report-uri`  → `application/csp-report`, one `{ "csp-report": {…} }`
//       - `report-to`   → `application/reports+json`, an ARRAY of
//                         `{ type: "csp-violation", body: {…} }` (Reporting API)
//
// The policy is still Report-Only. Without a sink it neither protected nor
// reported, so nobody could ever learn whether flipping it to enforcing would
// break audio playback or checkout. This is the evidence-gathering half: one
// compact greppable line per violation (`[csp-report] …` in the Vercel logs),
// and nothing else — no storage, no email, no response body.
//
// Everything in a report is attacker-controlled (anyone can POST here), so:
//   - the body is capped far below the shared 2 MiB reader cap,
//   - the route is rate-limited per IP,
//   - every logged value is stripped of control characters and truncated, so a
//     crafted report can't forge extra log lines or flood them,
//   - query strings and fragments are dropped from every URL before logging.
//     `document-uri` is the page the member was on, and ours can carry bearer
//     credentials (`/redeem?mt=…`, `/api/auth/email-login?lt=…`); a report sink
//     that wrote those into the logs would be a new leak, not a fix,
//   - nothing from the request is ever echoed back.

import { getClientIp, PayloadTooLargeError, readBody } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { defineRoute, type Route } from '../lib/route.js'

// A real report is ~1 KiB; a Reporting API batch is a handful of them. 16 KiB
// is generous for both and ~130x smaller than the shared reader's cap.
const MAX_REPORT_BYTES = 16 * 1024

// A Reporting API batch can hold many reports. Log the first few only — one
// page load that trips the same directive fifty times tells us nothing the
// first five lines didn't.
const MAX_REPORTS_PER_REQUEST = 5

const FIELD_MAX = 200

const ACCEPTED_TYPES = new Set([
  'application/csp-report',
  'application/reports+json',
  // Some older engines post the legacy shape as plain JSON.
  'application/json',
])

// Violations caused by the VISITOR's browser extensions injecting scripts or
// styles. They are not our page's doing, can't be fixed by us, and would
// otherwise be most of the log volume.
const EXTENSION_SCHEMES = [
  'chrome-extension:',
  'moz-extension:',
  'safari-extension:',
  'safari-web-extension:',
  'ms-browser-extension:',
]

export type CspReportLine = {
  blocked: string
  directive: string
  document: string
  source: string
  line: string
}

// Make one attacker-controlled value safe to put on a log line: strings and
// numbers only, control characters (incl. newlines — log forging) removed,
// spaces collapsed so the line stays `key=value` parseable, length capped.
function clean(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '-'
  const text = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, FIELD_MAX)
  return text === '' ? '-' : text
}

// Drop the query string and fragment. Works on absolute URLs and on the bare
// keywords browsers send instead of one (`inline`, `eval`, `data`, `blob`).
function stripQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : value.slice(0, cut)
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== '') return obj[key]
  }
  return undefined
}

function toLine(body: Record<string, unknown>): CspReportLine {
  return {
    blocked: clean(stripQuery(pick(body, 'blocked-uri', 'blockedURL'))),
    directive: clean(
      pick(body, 'effective-directive', 'effectiveDirective', 'violated-directive'),
    ),
    document: clean(stripQuery(pick(body, 'document-uri', 'documentURL'))),
    source: clean(stripQuery(pick(body, 'source-file', 'sourceFile'))),
    line: clean(pick(body, 'line-number', 'lineNumber')),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Normalise either wire format into loggable lines. Pure, so the parsing is
// unit-testable without a request. Anything that isn't a CSP report yields [].
export function parseCspReports(payload: unknown): CspReportLine[] {
  const bodies: Record<string, unknown>[] = []
  if (Array.isArray(payload)) {
    // Reporting API: the endpoint is shared by every report type the browser
    // knows (deprecation, intervention, …). Only CSP violations belong here.
    for (const entry of payload) {
      if (!isRecord(entry) || entry.type !== 'csp-violation') continue
      if (isRecord(entry.body)) bodies.push(entry.body)
    }
  } else if (isRecord(payload) && isRecord(payload['csp-report'])) {
    bodies.push(payload['csp-report'])
  }

  return bodies
    .slice(0, MAX_REPORTS_PER_REQUEST)
    .map(toLine)
    .filter(
      (line) =>
        !EXTENSION_SCHEMES.some(
          (scheme) => line.blocked.startsWith(scheme) || line.source.startsWith(scheme),
        ),
    )
}

export function cspReportRoutes(): Route[] {
  // A page that violates the policy does so a handful of times per load, and
  // browsers de-duplicate + batch. 20-report burst, then one every 2s, is room
  // for an honest browser and useless for filling the logs.
  const limiter = createRateLimiter({ capacity: 20, refillPerSec: 0.5 })

  return [
    defineRoute({
      path: '/api/csp-report',
      method: 'POST',
      handler: async (req, res) => {
        // Every outcome is a bare status with no body: the browser ignores the
        // response, and an empty one can't reflect anything.
        const done = (status: number) => {
          res.statusCode = status
          res.end()
        }

        const wait = limiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return done(429)
        }

        const contentType = String(req.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase()
        if (!ACCEPTED_TYPES.has(contentType)) return done(415)

        // readJson() can't be used: it reads with the shared 2 MiB cap. Read the
        // raw body ourselves under the small cap (the body reader is
        // content-type agnostic — it just drains the stream).
        let raw: Buffer
        try {
          raw = await readBody(req, MAX_REPORT_BYTES)
        } catch (err) {
          if (err instanceof PayloadTooLargeError) return done(413)
          throw err
        }

        let payload: unknown = null
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          // Malformed → nothing to log. Still 204: there is no caller to tell.
        }

        for (const line of parseCspReports(payload)) {
          console.warn(
            `[csp-report] blocked=${line.blocked} directive=${line.directive} ` +
              `document=${line.document} source=${line.source} line=${line.line}`,
          )
        }
        return done(204)
      },
    }),
  ]
}
