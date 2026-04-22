// Minimal control endpoint — no imports from the rest of the project. If this
// returns 200 while /api/handler returns FUNCTION_INVOCATION_FAILED, the
// Vercel runtime is healthy and the problem is in the handler's code or
// dependencies, not the deployment itself.

import type { IncomingMessage, ServerResponse } from 'node:http'

export default function ping(_req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, node: process.version }))
}
