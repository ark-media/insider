// ---------------------------------------------------------------------------
// Ark Insider — API plugin
//
// Backend for the marketing site, run as Vite middleware in dev and as a
// single Vercel Node Function (`api/handler.ts`) in production. The actual
// route implementations live in server/routes/{simplecast,beehiiv,circle,me,
// sms,stripe,gift,auth,cron}.ts; this file is the assembler that wires them
// to a per-instance dependency bundle.
//
// Auth: long-term sessions are Auth0 Bearer tokens; new subscribers get a
// short-lived HS256 `ark_checkout` JWT cookie so they can complete /setup
// before clicking the password-reset email. See `lib/session.ts`.
// ---------------------------------------------------------------------------

import type { Plugin, Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import Stripe from 'stripe'
import { createActivator } from './lib/activation.js'
import type { Deps, Env, Handler, Route } from './lib/route.js'
import { PayloadTooLargeError } from './lib/http.js'
import { adminRoutes } from './routes/admin.js'
import { adminMemberRoutes } from './routes/admin-members.js'
import { adminFeedActivationRoutes } from './routes/admin-feed-activations.js'
import { adminFeedReminderRoutes } from './routes/admin-feed-reminders.js'
import { announcementRoutes } from './routes/announcements.js'
import { accountRoutes } from './routes/account.js'
import { authRoutes } from './routes/auth.js'
import { beehiivRoutes } from './routes/beehiiv.js'
import { careerRoutes } from './routes/careers.js'
import { circleRoutes } from './routes/circle.js'
import { circleGateRoutes } from './routes/circle-gate.js'
import { contactRoutes } from './routes/contact.js'
import { cronRoutes } from './routes/cron.js'
import { discussThreadsRoutes } from './routes/discuss-threads.js'
import { faqRoutes } from './routes/faqs.js'
import { giftRoutes } from './routes/gift.js'
import { meRoutes } from './routes/me.js'
import { pricingRoutes } from './routes/pricing.js'
import { promoRoutes } from './routes/promo.js'
import { scWebhookRoutes } from './routes/sc-webhook.js'
import { simplecastRoutes } from './routes/simplecast.js'
import { smsRoutes } from './routes/sms.js'
import { stripeRoutes } from './routes/stripe/routes.js'

interface Api {
  appBaseUrl: string
  routes: Route[]
}

function buildApi(env: Env): Api {
  const stripeKey = env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : null
  const appBaseUrl = env.APP_BASE_URL || 'http://localhost:5173'
  const activator = createActivator(env, stripe)

  const deps: Deps = { env, stripe, appBaseUrl, activator }

  const routes: Route[] = [
    ...simplecastRoutes(deps),
    ...beehiivRoutes(deps),
    ...circleRoutes(deps),
    ...circleGateRoutes(deps),
    ...meRoutes(deps),
    ...pricingRoutes(deps),
    ...promoRoutes(deps),
    ...smsRoutes(deps),
    ...scWebhookRoutes(deps),
    ...stripeRoutes(deps),
    ...giftRoutes(deps),
    ...authRoutes(deps),
    ...accountRoutes(deps),
    ...announcementRoutes(deps),
    ...careerRoutes(deps),
    ...faqRoutes(deps),
    ...adminRoutes(deps),
    ...adminMemberRoutes(deps),
    ...adminFeedReminderRoutes(deps),
    ...adminFeedActivationRoutes(deps),
    ...discussThreadsRoutes(deps),
    ...contactRoutes(deps),
    ...cronRoutes(deps),
  ]

  return { appBaseUrl, routes }
}

// ---------------------------------------------------------------------------
// Vite dev plugin — registers each route as Connect middleware under its
// path. Keeps the exact surface the tests rely on
// (`plugin.configureServer(fake)` captures a handler per path via
// `server.middlewares.use(path, handler)`).
// ---------------------------------------------------------------------------
export function devApiPlugin(env: Env): Plugin {
  const api = buildApi(env)

  const withErrors =
    (path: string, handler: Handler) =>
    (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
      // Connect's `middlewares.use(path, ...)` matches by PREFIX, so a route
      // like `/api/me` would otherwise swallow `/api/me/newsletters`. The
      // production catch-all dispatches by exact pathname (see
      // createCatchAllHandler), so mirror that here: only run when the
      // request's pathname matches this route exactly, else fall through.
      //
      // The real Connect server always sets `originalUrl` to the pre-strip URL,
      // and that's the only place prefix-shadowing happens. Tests invoke the
      // captured handler directly (no `originalUrl`, no prefix ambiguity), so
      // the guard only applies when `originalUrl` is present.
      const original = (req as IncomingMessage & { originalUrl?: string })
        .originalUrl
      if (
        original !== undefined &&
        new URL(original, 'http://x').pathname !== path
      ) {
        return next()
      }
      handler(req, res).catch((err: unknown) => {
        if (err instanceof PayloadTooLargeError) {
          if (!res.headersSent) {
            res.statusCode = 413
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'payload_too_large' }))
          }
          return
        }
        console.error('[dev-api]', err)
        if (err && typeof err === 'object' && 'data' in err) {
          console.error(
            '[dev-api] error data:',
            JSON.stringify((err as { data: unknown }).data, null, 2),
          )
        }
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Internal error',
            }),
          )
        } else {
          next(err as Error)
        }
      })
    }

  return {
    name: 'ark-insider-dev-api',
    configureServer(server) {
      for (const { path, handler } of api.routes) {
        server.middlewares.use(path, withErrors(path, handler))
      }
    },
  }
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
