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
import { PayloadTooLargeError } from './lib/http.js'
import { buildApi } from './api.js'

// Keeps the exact surface the tests rely on: `plugin.configureServer(fake)`
// captures a handler per path via `server.middlewares.use(path, handler)`.
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
