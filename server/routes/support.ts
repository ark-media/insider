// Help-widget routes.
//
//   POST /api/support/log — public. Records one widget session so the team can
//     see what members ask and, more usefully, which questions the FAQ corpus
//     fails to answer.
//   GET /api/admin/support-conversations — admin-only. Recent sessions.
//
// Modelled on server/routes/contact.ts, the other public unauthenticated POST:
// rate-limited per IP, same-origin only, strict validation, generic errors.

import { getClientIp, isSameOrigin, readBody } from '../lib/http.js'
import { createSharedRateLimiter } from '../lib/shared-rate-limit.js'
import { requireAdminRequest } from '../lib/guards.js'
import { logAdminAction } from '../lib/admin-audit.js'
import { getDb } from '../lib/db.js'
import { resolveRequestIdentity } from '../lib/session.js'
import {
  listSupportSessions,
  recordSupportSession,
  SUPPORT_SESSIONS_DEFAULT_LIMIT,
  validateSupportSession,
} from '../lib/support.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'

// The whole site's support-widget writes for a day, and the most one request
// may carry. See the daily limiter below.
const DAILY_CEILING = 2000
const DAILY_KEY = 'all'
const MAX_LOG_BYTES = 64 * 1024

export function supportRoutes({ env, appBaseUrl }: Deps): Route[] {
  // A session re-posts as it grows, so the budget is per session rather than
  // per message: roughly a dozen interactions, then a slow trickle. Generous
  // enough for someone genuinely working through a problem, far too slow to be
  // worth using as a write amplifier.
  //
  // Shared across function instances (Neon-backed): this is a public,
  // unauthenticated write, and a per-instance bucket multiplies by however many
  // instances a script can fan out across.
  const limiter = createSharedRateLimiter(env, {
    name: 'support-log',
    capacity: 30,
    refillPerSec: 0.2,
  })
  // And one bucket for everyone, refilling over a day. The per-IP budget bounds
  // a single source; this bounds the sum, so a flood spread across addresses
  // (every IPv6 /64 is its own bucket) cannot grow the table without limit or
  // bury real escalations under invented ones in the admin view. Far above an
  // honest day's widget traffic.
  const dailyLimiter = createSharedRateLimiter(env, {
    name: 'support-log-daily',
    capacity: DAILY_CEILING,
    refillPerSec: DAILY_CEILING / 86_400,
  })

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

        const wait =
          (await limiter.take(getClientIp(req))) ?? (await dailyLimiter.take(DAILY_KEY))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        // A full session is 50 steps of 500 characters — well under this cap
        // even with the JSON around it. Anything bigger is not the widget, and
        // the shared 2 MiB reader would otherwise buffer it for nothing.
        const raw = await readBody(req, MAX_LOG_BYTES)
        let body: unknown = null
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : null
        } catch {
          body = null
        }
        const parsed = validateSupportSession(body)
        if (!parsed.ok) return json(400, { error: parsed.error })

        // Logging is a side benefit, never a dependency: if it isn't
        // configured, say OK and let the widget carry on helping people.
        if (!env.DATABASE_URL) return json(200, { ok: true })

        // Identity comes from the session cookie, never from the request body —
        // otherwise anyone could attribute a session to any email. It is also
        // what authorises an update to a session already attributed to a member:
        // recordSupportSession ignores a write to such a row from anyone else,
        // and we answer OK either way so the caller can't probe for it.
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
        // Reject a junk `?limit=` here rather than letting NaN reach the clamp.
        const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('limit')
        const parsed = raw === null || raw.trim() === '' ? NaN : Number(raw)
        if (raw !== null && !Number.isFinite(parsed)) {
          return json(400, { error: 'limit must be a number' })
        }
        const sessions = await listSupportSessions(
          getDb(env),
          Number.isFinite(parsed) ? parsed : SUPPORT_SESSIONS_DEFAULT_LIMIT,
        )
        // Sessions carry member emails and whatever they typed into the widget —
        // a bulk read of member data, so it goes in the trail (size only).
        await logAdminAction(env, admin, req, {
          action: 'support_conversations.read',
          summary: `rows=${sessions.length}`,
        })
        return json(200, { sessions })
      },
    }),
  ]
}
