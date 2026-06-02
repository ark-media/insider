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

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
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
