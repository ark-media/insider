// Svix webhook signature verification (what Beehiiv signs its deliveries
// with). Scheme, per https://docs.svix.com/receiving/verifying-payloads/how-manual:
//
//   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
//   signature      = base64( HMAC-SHA256( base64decode(secret sans "whsec_"), signed content ) )
//   svix-signature = space-separated `v1,<signature>` entries (several during
//                    a secret rotation); any one matching is a pass.
//
// Hand-rolled rather than a dependency: it is twenty lines, and the point of
// verifying is to depend on less, not more.

import { createHmac, timingSafeEqual } from 'node:crypto'

// Svix's own default. A replayed delivery older than this is refused even with
// a valid signature, so a captured request cannot be re-sent later.
const DEFAULT_TOLERANCE_SEC = 5 * 60

export type SvixHeaders = {
  id: string | string[] | undefined
  timestamp: string | string[] | undefined
  signature: string | string[] | undefined
}

export function verifySvixSignature(
  headers: SvixHeaders,
  body: Buffer,
  secret: string,
  opts: { nowSec?: number; toleranceSec?: number } = {},
): boolean {
  const id = single(headers.id)
  const timestamp = single(headers.timestamp)
  const signature = single(headers.signature)
  if (!id || !timestamp || !signature || !secret) return false

  const ts = Number(timestamp)
  if (!Number.isInteger(ts)) return false
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > (opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC)) return false

  let key: Buffer
  try {
    key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64')
  } catch {
    return false
  }
  if (key.length === 0) return false

  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest()

  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) continue
    const got = Buffer.from(value, 'base64')
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true
  }
  return false
}

function single(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null
  return typeof v === 'string' && v.length > 0 ? v : null
}
