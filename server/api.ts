// ---------------------------------------------------------------------------
// Ark Insider — API assembly + Vercel Function entry point.
//
// Backend for the marketing site. The route implementations live in
// server/routes/{podcasts,beehiiv,circle,me,feed-actions,stripe,gift,auth,
// cron}.ts; this file is the assembler that wires them to a per-instance
// dependency bundle, plus the catch-all handler `api/handler.ts` deploys.
//
// Nothing here may reference `vite`. This module IS the deployed function's
// import graph, and Vercel type-checks that graph against the root tsconfig
// with its own module resolution — a devDependency's types resolve differently
// there and show up as phantom errors in the build log. The dev-server plugin
// that does need Vite's types lives in ./dev-api.ts and imports `buildApi`
// from here.
//
// Auth: long-term sessions are Auth0 Bearer tokens; new subscribers get a
// short-lived HS256 `ark_checkout` JWT cookie so they can complete /setup
// before the welcome email's auto-login link is opened. See `lib/session.ts`.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'
import Stripe from 'stripe'
import { createActivator } from './lib/activation.js'
import type { Deps, Env, Handler, Route } from './lib/route.js'
import { PayloadTooLargeError } from './lib/http.js'
import { adminRoutes } from './routes/admin.js'
import { adminMemberRoutes } from './routes/admin-members.js'
import { adminFeedReminderRoutes } from './routes/admin-feed-reminders.js'
import { announcementRoutes } from './routes/announcements.js'
import { accountRoutes } from './routes/account.js'
import { authRoutes } from './routes/auth.js'
import { beehiivRoutes } from './routes/beehiiv.js'
import { careerRoutes } from './routes/careers.js'
import { circleRoutes } from './routes/circle.js'
import { circleGateRoutes } from './routes/circle-gate.js'
import { contactRoutes } from './routes/contact.js'
import { cspReportRoutes } from './routes/csp-report.js'
import { cronRoutes } from './routes/cron.js'
import { winbackRoutes } from './routes/winback.js'
import { discussThreadsRoutes } from './routes/discuss-threads.js'
import { faqRoutes } from './routes/faqs.js'
import { giftRoutes } from './routes/gift.js'
import { meRoutes } from './routes/me.js'
import { openHouseRoutes } from './routes/open-houses.js'
import { pricingRoutes } from './routes/pricing.js'
import { promoRoutes } from './routes/promo.js'
import { podcastRoutes } from './routes/podcasts.js'
import { feedActionRoutes } from './routes/feed-actions.js'
import { stripeRoutes } from './routes/stripe/routes.js'
import { supportRoutes } from './routes/support.js'

interface Api {
  appBaseUrl: string
  routes: Route[]
}

export function buildApi(env: Env): Api {
  const stripeKey = env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : null
  const appBaseUrl = env.APP_BASE_URL || 'http://localhost:5173'
  const activator = createActivator(env, stripe)

  const deps: Deps = { env, stripe, appBaseUrl, activator }

  const routes: Route[] = [
    ...podcastRoutes(deps),
    ...beehiivRoutes(deps),
    ...circleRoutes(deps),
    ...circleGateRoutes(deps),
    ...meRoutes(deps),
    ...pricingRoutes(deps),
    ...promoRoutes(deps),
    ...feedActionRoutes(deps),
    ...stripeRoutes(deps),
    ...giftRoutes(deps),
    ...authRoutes(deps),
    ...accountRoutes(deps),
    ...announcementRoutes(deps),
    ...openHouseRoutes(deps),
    ...careerRoutes(deps),
    ...faqRoutes(deps),
    ...adminRoutes(deps),
    ...adminMemberRoutes(deps),
    ...adminFeedReminderRoutes(deps),
    ...discussThreadsRoutes(deps),
    ...contactRoutes(deps),
    ...cspReportRoutes(),
    ...supportRoutes(deps),
    ...cronRoutes(deps),
    ...winbackRoutes(deps),
  ]

  return { appBaseUrl, routes }
}

// ---------------------------------------------------------------------------
// Catch-all handler factory — for Vercel Node Functions.
//
// Vercel's Hobby plan caps Serverless Functions at 12 per deployment, so
// instead of one file per route we expose a single `api/handler.ts` and use
// a vercel.json rewrite (`/api/(.*)` → `/api/handler?_path=$1`) to route
// every request through it. The original path arrives via the `_path` query
// param.
//
// Why the rewrite: Vercel's `[...slug]` filename pattern is a Next.js
// convention. In a plain Vite project it gets interpreted as a
// single-segment dynamic route, so `/api/foo` matches but `/api/foo/bar`
// returns NOT_FOUND.
//
// Init is guarded so a missing or malformed env var (e.g. a Stripe key that
// rejects at construction) surfaces as a readable JSON 500 instead of
// Vercel's opaque FUNCTION_INVOCATION_FAILED.
// ---------------------------------------------------------------------------
export function createCatchAllHandler(env: Env) {
  let routesByPath: Map<string, Handler> | null = null
  let initError: unknown = null

  try {
    const api = buildApi(env)
    routesByPath = new Map(api.routes.map((r) => [r.path, r.handler]))
  } catch (err) {
    initError = err
  }

  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (initError || !routesByPath) {
      // Log the detail server-side; never echo message/stack to the caller —
      // init failures expose file paths, config state, and driver internals.
      console.error('[api] init failed', initError)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'init_failed' }))
      return
    }

    // vercel.json rewrites `/api/*` to `/api/handler?_path=*`, so the
    // original path arrives in the `_path` query param. Fall back to the URL
    // pathname for non-Vercel callers (the dev server, tests) where the
    // handler is mounted directly at each route.
    const url = new URL(req.url ?? '', 'http://x')
    // A caller can put their own `_path` in the original query string, and
    // Vercel merges it with the rewrite-injected one. `.get()` returns the FIRST
    // match, whose position depends on undocumented merge ordering — so take the
    // LAST, which is the value the rewrite appended. No gate depends on the
    // path (every handler re-checks its own auth), but routing shouldn't rest on
    // a platform detail that could change under us.
    const slugs = url.searchParams.getAll('_path')
    const slug = slugs.length > 0 ? slugs[slugs.length - 1]! : null
    const pathname = slug !== null ? `/api/${slug}` : url.pathname
    const handler = routesByPath.get(pathname)
    if (!handler) {
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: 'not_found', path: pathname }))
      return
    }

    try {
      await handler(req, res)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        if (!res.headersSent) {
          res.statusCode = 413
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'payload_too_large' }))
        }
        return
      }
      console.error('[api]', err)
      if (err && typeof err === 'object' && 'data' in err) {
        console.error(
          '[api] error data:',
          JSON.stringify((err as { data: unknown }).data, null, 2),
        )
      }
      if (!res.headersSent) {
        // Generic body only — the detail is already logged above. Echoing
        // err.message leaks DB/driver internals and config state to callers.
        res.statusCode = 500
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    }
  }
}

