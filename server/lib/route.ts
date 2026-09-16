// Shared route types. Every per-domain module under server/routes returns
// an `Route[]` constructed against the same `Deps` shape, so dev-api.ts can
// concat them into a single dispatch table without per-domain glue.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type Stripe from 'stripe'
import type { Activator } from './activation.js'
import { makeJsonRes, type JsonRes } from './http.js'

export type Env = Record<string, string>
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
export type Route = { path: string; handler: Handler }

export type Deps = {
  env: Env
  stripe: Stripe | null
  appBaseUrl: string
  activator: Activator
}

// A route handler that receives the JSON responder ready-made. Every route body
// opened with `const json = makeJsonRes(res)`; defineRoute hands it in instead.
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonRes,
) => Promise<void>

// Build a Route from a handler: constructs the JSON responder, enforces the
// allowed method(s) with one uniform 405, then delegates. `method` accepts a
// single verb or a list; omit it when the handler dispatches methods itself or
// must run another gate (e.g. an admin check) before rejecting the method — the
// wrapper then only supplies `json`.
export function defineRoute(opts: {
  path: string
  method?: string | string[]
  handler: RouteHandler
}): Route {
  const allowed =
    opts.method == null
      ? null
      : Array.isArray(opts.method)
        ? opts.method
        : [opts.method]
  return {
    path: opts.path,
    handler: async (req, res) => {
      const json = makeJsonRes(res)
      if (allowed && !allowed.includes(req.method ?? 'GET')) {
        return json(405, { error: 'Method Not Allowed' })
      }
      await opts.handler(req, res, json)
    },
  }
}
