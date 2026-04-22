// ---------------------------------------------------------------------------
// Vercel catch-all Node function for /api/*
//
// Vite's dev server runs `devApiPlugin` as middleware, but `vite build` only
// produces static assets — so in production the /api/* routes have no server.
// This file boots the same route handlers (via `createApiHandler`) inside a
// single Vercel Serverless Function, giving us identical behavior on one
// domain without a separate backend.
//
// The filename `[...path].ts` is Vercel's catch-all pattern: any request to
// /api/<anything> is routed here, with `req.url` carrying the full path so
// `createApiHandler` can dispatch on it.
//
// `bodyParser: false` is required for the Stripe webhook route, which reads
// the raw request body to verify the signature. Other routes read JSON via
// the same stream — they work the same with or without bodyParser, so turning
// it off globally is the safe default.
//
// Caveat: the in-memory rate-limiter buckets and consumed-nonce set in
// `createApiHandler` don't survive across function invocations. At this
// traffic level it's acceptable; the upstream SC API also rate-limits.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiHandler } from '../server/dev-api'

const handle = createApiHandler(process.env as Record<string, string>)

export default function handler(req: IncomingMessage, res: ServerResponse) {
  return handle(req, res)
}

export const config = {
  api: {
    bodyParser: false,
  },
}
