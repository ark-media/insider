// The win-back campaign's unsubscribe endpoint.
//
// This is the only mail this codebase sends to someone who is not a customer,
// so it carries a real one-click opt-out rather than "reply to this email".
// The link is self-authenticating: the address travels in the URL alongside an
// HMAC over it, so clicking works with no session — the recipient no longer has
// an account to sign in to.
//
// GET, and deliberately not idempotency-sensitive: mail clients and security
// scanners prefetch links, and a prefetch that silently opts someone out is a
// bug — but opting out of a win-back campaign is the safe direction to fail, so
// this accepts that rather than interposing a confirm screen the recipient
// would have to find.

import { createHmac } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { getDb } from '../lib/db.js'
import { normalizeEmail } from '../lib/feed-activations.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { secretEquals } from '../lib/timing-safe.js'
import { suppressWinback } from '../lib/winback.js'

type Env = Record<string, string>

// HMAC over the normalized address. Deterministic so a link mailed months ago
// still verifies, and unguessable so the endpoint can't be used to opt out an
// arbitrary address.
export function winbackUnsubToken(email: string, env: Env): string {
  const secret = env.SESSION_SECRET || env.CHECKOUT_SESSION_SECRET
  // Never default this. The token is the only authorization on this endpoint,
  // so a hardcoded fallback would let anyone suppress any address. Match the
  // 32-byte floor the other first-party tokens enforce.
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET (>= 32 bytes) required to derive win-back tokens')
  }
  return createHmac('sha256', secret)
    .update(`winback-unsub:${normalizeEmail(email)}`)
    .digest('base64url')
}

export function winbackUnsubUrl(email: string, env: Env, appBaseUrl: string): string {
  const e = Buffer.from(normalizeEmail(email), 'utf8').toString('base64url')
  return `${appBaseUrl}/api/winback/unsubscribe?e=${e}&t=${winbackUnsubToken(email, env)}`
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader('content-type', 'text/html; charset=utf-8')
  // Never let a shared cache hold a page keyed on someone's address.
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

// Standalone markup — this page is reached from the win-back email by someone
// with no session, so it never boots the SPA and can't read the member's theme
// preference. It is pinned to the same light palette as the email that links
// here (see the shell in server/lib/welcome-email.ts), so the click doesn't
// land on a page that looks like a different product.
function page(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${title}</title>
  </head>
  <body style="margin:0;background:#eef3fc;color:#373f5f;font:400 16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <main style="max-width:520px;margin:0 auto;padding:64px 24px;">
      <p style="margin:0 0 24px;font:800 20px system-ui;color:#0b153c;">Ark<span style="color:#0a6fad;">+</span></p>
      <h1 style="margin:0 0 12px;font:700 24px/1.25 system-ui;color:#0b153c;">${title}</h1>
      <p style="margin:0;">${message}</p>
    </main>
  </body>
</html>`
}

export function winbackRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/winback/unsubscribe',
      method: ['GET', 'POST'],
      handler: async (req, res) => {
        const url = new URL(req.url ?? '', appBaseUrl)
        const e = url.searchParams.get('e') ?? ''
        const t = url.searchParams.get('t') ?? ''

        let email = ''
        try {
          email = normalizeEmail(Buffer.from(e, 'base64url').toString('utf8'))
        } catch {
          email = ''
        }

        // One response for every failure — a bad token and an unknown address
        // must not be distinguishable, or this becomes an address oracle.
        let expected = ''
        try {
          expected = email ? winbackUnsubToken(email, env) : ''
        } catch (err) {
          console.error('[winback] unsubscribe token derivation failed:', err)
          return sendHtml(
            res,
            500,
            page(
              'Something went wrong',
              'We couldn’t process that just now. Please email support@arkmedia.org and we’ll take care of it.',
            ),
          )
        }
        if (!email || !expected || !secretEquals(t, expected)) {
          return sendHtml(
            res,
            400,
            page(
              'That link didn’t work',
              'This unsubscribe link looks incomplete. Email support@arkmedia.org and we’ll take you off the list.',
            ),
          )
        }

        if (env.DATABASE_URL) {
          try {
            await suppressWinback(getDb(env), email)
          } catch (err) {
            console.error('[winback] suppression write failed:', err)
            return sendHtml(
              res,
              500,
              page(
                'Something went wrong',
                'We couldn’t save that just now. Please email support@arkmedia.org and we’ll take care of it.',
              ),
            )
          }
        }

        sendHtml(
          res,
          200,
          page(
            'You’re unsubscribed',
            'We won’t email you about rejoining again. This doesn’t affect any newsletters you’re signed up for.',
          ),
        )
      },
    }),
  ]
}
