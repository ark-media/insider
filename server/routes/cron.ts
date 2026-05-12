// Entitlement reconciliation cron. Vercel cron hits this nightly. Three-pass
// sync against Stripe + Auth0 + Circle; see ../entitlement.ts for the
// passes.
//
// Auth: cron requests from Vercel include `Authorization: Bearer
// <CRON_SECRET>` matching the secret set in the project's environment.

import crypto from 'node:crypto'
import { reconcileEntitlements } from '../entitlement.js'
import { makeJsonRes } from '../lib/http.js'
import type { Deps, Route } from '../lib/route.js'

export function cronRoutes({ env, stripe }: Deps): Route[] {
  return [
    {
      path: '/api/cron/reconcile-entitlements',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST' && req.method !== 'GET') {
          return json(405, { error: 'Method Not Allowed' })
        }
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'CRON_SECRET missing' })
        const auth = req.headers.authorization ?? ''
        const expected = `Bearer ${cronSecret}`
        // Constant-time compare so a wrong secret can't be guessed
        // byte-by-byte via response-timing differences. Buffer lengths must
        // match for timingSafeEqual; the length check below is short-circuit
        // safe.
        const got = Buffer.from(auth)
        const want = Buffer.from(expected)
        if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const summary = await reconcileEntitlements(env, stripe)
        json(200, {
          scanned: summary.scanned,
          upgraded: summary.upgraded,
          downgraded: summary.downgraded,
          errors: summary.errors,
        })
      },
    },
  ]
}
