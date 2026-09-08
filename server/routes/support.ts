// Help-widget routes.
//
//   POST /api/support/log — public. Records one widget session so the team can
//     see what members ask and, more usefully, which questions the FAQ corpus
//     fails to answer.
//   GET /api/admin/support-conversations — admin-only. Recent sessions.
//
// Modelled on server/routes/contact.ts, the other public unauthenticated POST:
// rate-limited per IP, same-origin only, strict validation, generic errors.

import { getClientIp, isSameOrigin, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { requireAdminRequest } from '../lib/guards.js'
import { getDb } from '../lib/db.js'
import { resolveRequestIdentity } from '../lib/session.js'
import {
  listSupportSessions,
  recordSupportSession,
  validateSupportSession,
} from '../lib/support.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'

export function supportRoutes({ env, appBaseUrl }: Deps): Route[] {
  // A session re-posts as it grows, so the budget is per session rather than
  // per message: roughly a dozen interactions, then a slow trickle. Generous
  // enough for someone genuinely working through a problem, far too slow to be
  // worth using as a write amplifier.
  const limiter = createRateLimiter({ capacity: 30, refillPerSec: 0.2 })

  return [
    defineRoute({
      path: '/api/support/log',
      method: 'POST',
      handler: async (req, res, json) => {
        // This writes to the database and has no business being called from
        // anywhere but the site itself.
        if (!isSameOrigin(req, appBaseUrl)) {
          return json(403, { error: 'bad_origin' })
        }

        const wait = limiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const parsed = validateSupportSession(await readJson(req))
        if (!parsed.ok) return json(400, { error: parsed.error })

        // Logging is a side benefit, never a dependency: if it isn't
        // configured, say OK and let the widget carry on helping people.
        if (!env.DATABASE_URL) return json(200, { ok: true })

        // Identity comes from the session cookie, never from the request body —
        // otherwise anyone could attribute a session to any email.
        const identity = await resolveRequestIdentity(req, env).catch(() => null)

        try {
          await recordSupportSession(getDb(env), parsed.value, identity?.email ?? null)
        } catch (err) {
          // Same posture as /api/faqs: a DB hiccup must not break the widget.
          console.error('[support] log failed:', err)
        }
        return json(200, { ok: true })
      },
    }),

    defineRoute({
      path: '/api/admin/support-conversations',
      method: 'GET',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return

        if (!env.DATABASE_URL) return json(200, { sessions: [] })
        const limit = Number(
          new URL(req.url ?? '/', 'http://x').searchParams.get('limit') ?? '200',
        )
        const sessions = await listSupportSessions(getDb(env), limit)
        return json(200, { sessions })
      },
    }),
  ]
}
