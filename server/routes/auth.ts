// Auth/session routes.
//
//   POST /api/auth/checkout-session — brand-new subscribers don't have an
//     Auth0 password yet; the webhook will send them a password-reset email
//     so they can pick one for future logins. To get them into /setup
//     immediately without round-tripping through that email, we provision
//     their account synchronously and hand back a short-lived HS256 JWT
//     usable as a Bearer token. The other routes accept either Auth0 RS256
//     tokens or this token (see lib/session.ts).
//   POST /api/signout — clears the checkout-session cookies. The client
//     calls this before Auth0 logout so brand-new subscribers fully sign
//     out without leaving a 30-min cookie behind.

import type Stripe from 'stripe'
import * as client from 'openid-client'
import { AlreadySubscribedError } from '../lib/activation.js'
import { AUTH0_DOMAIN } from '../auth0.js'
import { AUTH0_AUDIENCE } from '../../shared/auth0-claims.js'
import {
  AUTH_TXN_COOKIE_NAME,
  CHECKOUT_TOKEN_TTL_SEC,
  clearAuthTxnCookie,
  clearCheckoutCookies,
  clearSessionCookies,
  readCookie,
  setAuthTxnCookie,
  setCheckoutCookies,
  setSessionCookies,
} from '../lib/cookies.js'
import { makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { getOidcConfig, OidcNotConfiguredError } from '../lib/oidc.js'
import {
  signAuthTxnToken,
  signCheckoutToken,
  signSessionToken,
  verifyAuth0BearerProfile,
  verifyAuthTxnToken,
  type SessionProfile,
} from '../lib/session.js'
import type { Deps, Route } from '../lib/route.js'

// Only same-origin returnTo values are honored — never a protocol-relative
// ("//evil.com"), backslash, encoded, or absolute URL, which would turn the
// login redirect into an open redirect. Resolve against our own origin and
// keep only the path/query/hash; anything that lands on another origin (or
// won't parse) falls back to "/". This authoritative parse replaces the older
// prefix-matching, which enumerated cases the browser could still normalize.
export function safeReturnTo(
  raw: string | null | undefined,
  appBaseUrl: string,
): string {
  if (!raw) return '/'
  try {
    const u = new URL(raw, appBaseUrl)
    if (u.origin !== new URL(appBaseUrl).origin) return '/'
    return u.pathname + u.search + u.hash
  } catch {
    return '/'
  }
}

function redirect(res: import('node:http').ServerResponse, location: string): void {
  res.statusCode = 302
  res.setHeader('Location', location)
  res.end()
}

// Resolve the OIDC config, or write a 500 and return null when the
// confidential-client env isn't configured (so /login and /callback share one
// failure path).
async function loadOidcConfig(
  env: Record<string, string>,
  res: import('node:http').ServerResponse,
): Promise<client.Configuration | null> {
  try {
    return await getOidcConfig(env)
  } catch (err) {
    if (err instanceof OidcNotConfiguredError) {
      makeJsonRes(res)(500, { error: 'auth_not_configured' })
      return null
    }
    throw err
  }
}

// Defense against replay of leaked (checkout_session_id, email) pairs:
// auto-login is only valid during the brief window right after checkout. After
// that, the user logs in normally via Auth0 with the password they set from the
// reset email.
const AUTO_LOGIN_WINDOW_SEC = 60 * 60

export function authRoutes({ env, stripe, activator, appBaseUrl }: Deps): Route[] {
  const callbackUrl = `${appBaseUrl}/api/auth/callback`
  // /api/auth/checkout-session is polled by the client (~1 req/s during the
  // 20s window after payment). Cap per Checkout Session to defend the upstream
  // Stripe + Auth0 APIs from runaway loops or scripted abuse.
  const checkoutSessionLimiter = createRateLimiter({
    capacity: 25,
    refillPerSec: 1,
  })

  return [
    {
      path: '/api/auth/checkout-session',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
        if (!env.CHECKOUT_SESSION_SECRET) {
          return json(500, { error: 'CHECKOUT_SESSION_SECRET missing' })
        }

        const body =
          (await readJson<{ checkout_session_id?: string; email?: string }>(req)) ?? {}
        const sessionId = body.checkout_session_id?.trim()
        const emailParam = body.email?.trim().toLowerCase()
        if (!sessionId) return json(400, { error: 'checkout_session_id required' })
        if (!emailParam) return json(400, { error: 'email required' })

        const wait = checkoutSessionLimiter.take(sessionId)
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'Too many attempts. Please wait a moment.' })
        }

        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['subscription', 'subscription.customer'],
        })

        // The Checkout Session creates the subscription only once payment
        // completes. Until then there's nothing to provision — tell the client
        // to retry.
        const sub =
          typeof session.subscription === 'object' && session.subscription
            ? session.subscription
            : null
        if (!sub) {
          return json(202, { ready: false, status: session.status ?? 'open' })
        }

        const customer = sub.customer
        const customerEmail =
          typeof customer === 'object' &&
          customer &&
          !('deleted' in customer && customer.deleted)
            ? (customer as Stripe.Customer).email?.toLowerCase() ?? null
            : null
        if (!customerEmail || customerEmail !== emailParam) {
          return json(403, { error: 'Forbidden' })
        }

        if (Date.now() / 1000 - sub.created > AUTO_LOGIN_WINDOW_SEC) {
          return json(410, {
            error: 'Auto-login window expired. Please sign in via the link in your welcome email.',
          })
        }

        // Stripe activates the subscription only after the payment confirms.
        // The client calls this endpoint right after checkout.confirm()
        // resolves, but Stripe's internal state transition can lag by a few
        // hundred ms. Tell the client to retry.
        if (sub.status !== 'active' && sub.status !== 'trialing') {
          return json(202, { ready: false, status: sub.status })
        }

        // Provision SC user + SC subscription + Auth0 user. Idempotent — if
        // the webhook already ran, this is a no-op. Failures here mean the
        // caller paid but provisioning is incomplete; the webhook will retry
        // async, but we shouldn't hand out a session token yet.
        try {
          await activator.activateScSubscriptionForStripeSub(sub)
        } catch (err) {
          if (err instanceof AlreadySubscribedError) {
            // The new Stripe sub paid through, but SC already has an active sub
            // for this user — usually a prior membership that wasn't fully torn
            // down. Tell the buyer rather than the generic provisioning error;
            // billing reconciliation is a separate manual step.
            return json(409, {
              error:
                'This email already has an active Insider membership. Please sign in instead — and email support@arkmedia.org if you were charged for this second attempt.',
              code: 'already_subscribed',
            })
          }
          console.error('[auth/checkout-session] provision failed:', err)
          return json(502, {
            error: 'Could not finish setting up your account. Please try again.',
          })
        }

        const accessToken = await signCheckoutToken(customerEmail, env)
        setCheckoutCookies(res, accessToken, env)
        json(200, {
          ready: true,
          email: customerEmail,
          expires_in: CHECKOUT_TOKEN_TTL_SEC,
        })
      },
    },

    {
      path: '/api/signout',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })
        clearCheckoutCookies(res, env)
        clearSessionCookies(res, env)
        json(200, { ok: true })
      },
    },

    // --- Server-side OAuth login (BFF) -----------------------------------
    //
    // The browser never touches an Auth0 token. /login runs PKCE + state +
    // nonce and stashes them in an httpOnly txn cookie; /callback exchanges
    // the code, verifies the access token, and mints our own httpOnly
    // `ark_session` cookie. See lib/oidc.ts and lib/session.ts.
    {
      path: '/api/auth/login',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', appBaseUrl)
        const returnTo = safeReturnTo(url.searchParams.get('returnTo'), appBaseUrl)
        const screenHint = url.searchParams.get('screen_hint')
        const loginHint = url.searchParams.get('login_hint')

        const config = await loadOidcConfig(env, res)
        if (!config) return

        const verifier = client.randomPKCECodeVerifier()
        const challenge = await client.calculatePKCECodeChallenge(verifier)
        const state = client.randomState()
        const nonce = client.randomNonce()

        const txn = await signAuthTxnToken({ verifier, state, nonce, returnTo }, env)
        setAuthTxnCookie(res, txn, env)

        const authUrl = client.buildAuthorizationUrl(config, {
          redirect_uri: callbackUrl,
          scope: 'openid profile email',
          audience: AUTH0_AUDIENCE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          nonce,
          ...(screenHint === 'signup' ? { screen_hint: 'signup' } : {}),
          ...(loginHint ? { login_hint: loginHint } : {}),
        })

        redirect(res, authUrl.href)
      },
    },

    {
      path: '/api/auth/callback',
      handler: async (req, res) => {
        const txnToken = readCookie(req, AUTH_TXN_COOKIE_NAME)
        const txn = txnToken ? await verifyAuthTxnToken(txnToken, env) : null
        clearAuthTxnCookie(res, env)
        if (!txn) {
          // No/expired transaction — likely a stale tab or a replayed callback.
          return redirect(res, '/?auth_error=expired')
        }

        const config = await loadOidcConfig(env, res)
        if (!config) return

        // Rebuild the callback URL openid-client validates against. In prod the
        // real path arrives via the `_path` rewrite param, so strip it and keep
        // only the OAuth params (code, state) on the canonical callback URL.
        const incoming = new URL(req.url ?? '/', appBaseUrl)
        incoming.searchParams.delete('_path')
        const currentUrl = new URL(callbackUrl)
        currentUrl.search = incoming.search

        let tokens: client.TokenEndpointResponse
        try {
          tokens = await client.authorizationCodeGrant(config, currentUrl, {
            pkceCodeVerifier: txn.verifier,
            expectedState: txn.state,
            expectedNonce: txn.nonce,
          })
        } catch (err) {
          console.error('[auth/callback] code exchange failed:', err)
          return redirect(res, '/?auth_error=exchange')
        }

        // Roles/tier/email ride the access-token custom claims (emitted by the
        // Auth0 Login Action). Verify it with the same path the API uses.
        const accessToken = tokens.access_token
        const profile = accessToken
          ? await verifyAuth0BearerProfile(accessToken)
          : null
        if (!profile?.email) {
          console.error('[auth/callback] access token missing/invalid')
          return redirect(res, '/?auth_error=profile')
        }

        const session: SessionProfile = {
          email: profile.email,
          roles: profile.roles,
          name: profile.name,
          tier: profile.tier,
        }
        setSessionCookies(res, await signSessionToken(session, env), env)
        // Re-validate defensively: the txn is signed, but this keeps the
        // open-redirect guard at the actual redirect site too.
        redirect(res, safeReturnTo(txn.returnTo, appBaseUrl))
      },
    },

    {
      path: '/api/auth/logout',
      handler: async (req, res) => {
        // Logout must stay a top-level GET (it redirects through Auth0's
        // /v2/logout), so it can't use the Origin-based CSRF check. Block the
        // forced-logout vector instead. A genuine in-app sign-out is a
        // same-origin, top-level navigation (Sec-Fetch-Dest: document). An
        // attacker's <img>/<script>/fetch carries either a cross-site
        // Sec-Fetch-Site or a non-document Sec-Fetch-Dest; rejecting both stops
        // the response's cookie-clearing Set-Cookie from firing on a
        // sub-resource load. Browsers that omit these headers pass through.
        const fetchSite = req.headers['sec-fetch-site']
        const fetchDest = req.headers['sec-fetch-dest']
        if (
          fetchSite === 'cross-site' ||
          (typeof fetchDest === 'string' && fetchDest !== 'document')
        ) {
          return redirect(res, appBaseUrl)
        }
        clearSessionCookies(res, env)
        clearCheckoutCookies(res, env)
        // End the Auth0 SSO session too, then come back to the app origin.
        const clientId = env.AUTH0_WEB_CLIENT_ID
        if (clientId) {
          const logoutUrl = new URL(`${AUTH0_DOMAIN}/v2/logout`)
          logoutUrl.searchParams.set('client_id', clientId)
          logoutUrl.searchParams.set('returnTo', appBaseUrl)
          return redirect(res, logoutUrl.href)
        }
        redirect(res, appBaseUrl)
      },
    },
  ]
}
