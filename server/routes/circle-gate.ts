// ---------------------------------------------------------------------------
// Circle SSO login gate — the service half of Layer 1.
//
//   POST /api/internal/circle-access   { "sub": "auth0|..." }
//        -> 200 { allow, tier }
//
// Members sign into the Circle community (app.arkmedia.org) with their Auth0
// credentials: Circle's Custom SSO bounces them through our tenant and maps the
// returned identity onto a community member. Circle cannot gate that itself —
// it consumes `sub`/`email`/`name` and has no "deny unless claim X" rule, and it
// AUTO-PROVISIONS a member for anyone who completes the handshake (see the 404
// -> 'no-member' comment in ../entitlement.ts). So an Ark+-only subscriber, who
// bought the podcasts and not the community, would otherwise walk straight in —
// silently, because the website has already established an Auth0 session.
//
// The gate therefore lives in the Auth0 post-login Action (auth0/actions/
// post-login.js), which is the one place able to stop the transaction. This
// endpoint is what the Action asks. It exists rather than the Action reading
// Neon directly so that GRANTS / liveAxes stay in exactly one place: a login
// gate that re-implemented "which tiers include the community" is precisely the
// multi-authority drift the Neon cutover removed (tasks/entitlement-tiers.md
// §3). Auth0 still carries NO entitlement — it asks, per login.
//
// Auth: `Authorization: Bearer <CIRCLE_GATE_SECRET>`, constant-time compared,
// matching the cron routes. The secret is an Action secret on the Auth0 side.
//
// Answers are deliberately terse: a boolean and the tier, no email, no row.
// This is an internal service-to-service call, and the Action needs nothing
// else to decide.
//
// NOTE this gate only governs NEW logins. A member who cancels keeps their live
// Circle session until it expires — the access-group revocation in
// ../entitlement.ts (Layer 2) is what actually cuts them off. The two are
// complementary; neither replaces the other.
// ---------------------------------------------------------------------------

import type { IncomingMessage } from 'node:http'
import { resolveEntitlementsForSub } from '../lib/entitlement-resolver.js'
import { readJson } from '../lib/http.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { secretEquals } from '../lib/timing-safe.js'

function gateAuthorized(req: IncomingMessage, secret: string): boolean {
  return secretEquals(req.headers.authorization ?? '', `Bearer ${secret}`)
}

export function circleGateRoutes({ env }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/internal/circle-access',
      method: 'POST',
      handler: async (req, res, json) => {
        // Identity-scoped and secret-gated: never cacheable by anything.
        res.setHeader('cache-control', 'private, no-store')

        const secret = env.CIRCLE_GATE_SECRET
        // Unconfigured is a 500, not a 401: the Action distinguishes the two
        // only by "not 200", but the log line matters when someone is asking
        // why every community login is being turned away.
        if (!secret) return json(500, { error: 'not_configured' })
        // Checked before the body is read, so an unauthenticated caller can't
        // learn anything from how we react to what they sent.
        if (!gateAuthorized(req, secret)) return json(401, { error: 'unauthorized' })
        if (!env.DATABASE_URL) return json(500, { error: 'not_configured' })

        const body = await readJson<{ sub?: unknown }>(req)
        const sub = typeof body?.sub === 'string' ? body.sub.trim() : ''
        if (!sub) return json(400, { error: 'missing_sub' })

        try {
          const { tier, entitlements } = await resolveEntitlementsForSub(sub, env)
          json(200, { allow: entitlements.circle, tier })
        } catch (err) {
          // A Neon outage must not read as "not entitled" — that would send a
          // paying member to the upsell page. Surface it as a failure so the
          // Action tells them to try again instead.
          console.error('[circle-gate] entitlement lookup failed:', err)
          json(500, { error: 'lookup_failed' })
        }
      },
    }),
  ]
}
