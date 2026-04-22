// ---------------------------------------------------------------------------
// Vercel serverless function — single handler for all /api/* requests.
//
// Vercel's file-based dynamic routing (`api/[...path].ts`) turned out to only
// match single-segment paths in this non-Next.js project, so we use an
// explicit `vercel.json` rewrite instead. The rewrite maps every /api/*
// request to this file and preserves the original path via the `_vpath`
// query parameter. We strip `_vpath` back out and hand `createApiHandler`
// the URL it expects to see.
//
// `bodyParser: false` keeps the raw request body intact for the Stripe
// webhook, which verifies the signature against the untouched payload.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiHandler } from '../server/dev-api'

const handle = createApiHandler(process.env as Record<string, string>)

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const raw = req.url ?? '/'
  const qIdx = raw.indexOf('?')
  if (qIdx !== -1) {
    const params = new URLSearchParams(raw.slice(qIdx + 1))
    const vpath = params.get('_vpath')
    if (vpath) {
      params.delete('_vpath')
      const rest = params.toString()
      req.url = vpath + (rest ? '?' + rest : '')
    }
  }
  return handle(req, res)
}

export const config = {
  api: {
    bodyParser: false,
  },
}
