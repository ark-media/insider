// ---------------------------------------------------------------------------
// Ark Insider — Vite dev-server plugin.
//
// Mounts the same routes the deployed function serves (see ./api.ts) as
// Connect middleware, so `vite dev` and production share one route table.
// Dev-only: `api/handler.ts` must never reach this file, because the `vite`
// types below would then land in the deployed function's type graph.
// ---------------------------------------------------------------------------

import type { Plugin, Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Env, Handler } from './lib/route.js'
import { PayloadTooLargeError, makeJsonRes } from './lib/http.js'
import { buildApi } from './api.js'
import { SC_FEED_REDIRECT_PATH } from './routes/sc-feed-redirect.js'

// Keeps the exact surface the tests rely on: `plugin.configureServer(fake)`
// captures a handler per path via `server.middlewares.use(path, handler)`.
export function devApiPlugin(env: Env): Plugin {
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
        const json = makeJsonRes(res)
        if (err instanceof PayloadTooLargeError) {
          if (!res.headersSent) json(413, { error: 'payload_too_large' })
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
          json(500, { error: err instanceof Error ? err.message : 'Internal error' })
        } else {
          next(err as Error)
        }
      })
    }

  return {
    name: 'ark-insider-dev-api',
    configureServer(server) {
      // Built here, not when the plugin is created: vite.config.ts creates it
      // for `vite build` too, and buildApi's deploy guards (the Preview
      // integration check) would fail a production bundle that never runs
      // this API.
      const api = buildApi(env)
      // The one non-/api path: a Supporting Cast feed URL. vercel.json rewrites
      // `/content/<token>.rss` to the redirect route with the token as a query
      // param; mirror that here so the dev server answers the same URL. Registered
      // first so the rewritten URL is what the route middlewares below match on
      // (Connect fixes `originalUrl` at entry, so it is rewritten too — the exact-
      // path guard in withErrors reads it).
      server.middlewares.use((req, _res, next) => {
        const m = (req.url ?? '').match(/^\/content\/([^/?#]+)\.rss(?:\?|$)/)
        if (m) {
          req.url = `${SC_FEED_REDIRECT_PATH}?token=${m[1]}`
          ;(req as IncomingMessage & { originalUrl?: string }).originalUrl = req.url
        }
        next()
      })
      for (const { path, handler } of api.routes) {
        server.middlewares.use(path, withErrors(path, handler))
      }
    },
  }
}
