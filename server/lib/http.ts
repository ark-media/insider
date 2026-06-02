// HTTP helpers shared by every route in server/routes. Kept tiny on purpose
// — anything that needs more shape goes in its own module.

import type { IncomingMessage, ServerResponse } from 'node:http'

export type JsonRes = (status: number, body: unknown) => void

export function makeJsonRes(res: ServerResponse): JsonRes {
  return (status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
}

// Thrown by readBody when a request exceeds the byte cap. The catch-all maps
// it to a 413 instead of buffering an unbounded body into memory.
export class PayloadTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'PayloadTooLargeError'
  }
}

// Generous cap that bounds per-request memory without rejecting any legitimate
// payload — our own POSTs (contact, subscribe, sms, newsletter prefs) are a few
// KB, and Stripe webhook events stay well under this. Aborts as soon as the cap
// is crossed, so a malicious large body can't OOM the function instance.
const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2 MiB

export async function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buf.length
    if (total > maxBytes) throw new PayloadTooLargeError()
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

// CSRF defense for cookie-authenticated mutations. Now that the session rides
// an httpOnly cookie (auto-attached by the browser), a cross-site page could
// otherwise trigger state-changing requests. SameSite=Lax already blocks the
// cookie on cross-site POST/PUT/DELETE; this is belt-and-suspenders: reject
// when an Origin header is present and doesn't match our own. Absent Origin
// (non-browser callers, same-origin GET) is allowed — those carry no ambient
// cross-site cookie to abuse.
export function isSameOrigin(req: IncomingMessage, appBaseUrl: string): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  return origin === appBaseUrl
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const buf = await readBody(req)
  if (!buf.length) return null
  try {
    return JSON.parse(buf.toString('utf8')) as T
  } catch {
    return null
  }
}

// Extracts the leftmost x-forwarded-for entry (Vercel sets this — the original
// client; downstream proxies append themselves to the right), falling back to
// the socket address for the dev server. Used as the per-client rate-limit key.
export function getClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim()
  if (Array.isArray(xff) && xff.length > 0) return xff[0]!
  return req.socket?.remoteAddress ?? 'unknown'
}
