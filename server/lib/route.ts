// Shared route types. Every per-domain module under server/routes returns
// an `Route[]` constructed against the same `Deps` shape, so dev-api.ts can
// concat them into a single dispatch table without per-domain glue.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type Stripe from 'stripe'
import type { Activator } from './activation.js'

export type Env = Record<string, string>
export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
export type Route = { path: string; handler: Handler }

export type Deps = {
  env: Env
  stripe: Stripe | null
  appBaseUrl: string
  activator: Activator
}
