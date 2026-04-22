// ---------------------------------------------------------------------------
// Vercel serverless function — single handler for all /api/* requests.
//
// Vercel's file-based dynamic routing (`api/[...path].ts`) only matched
// single-segment paths in this non-Next.js project, so routing goes through
// an explicit `vercel.json` rewrite instead: every /api/* is rewritten to
// /api/handler with the original path carried in the `_vpath` query param.
// We strip `_vpath` back out and hand `createApiHandler` the URL it expects.
//
// Import is static (not dynamic) so Vercel's file tracer includes
// `server/dev-api.ts` in the function bundle. `dev-api.ts` has no top-level
// side effects, so the import itself can't throw — only the
// `createApiHandler(env)` call can (e.g. if `@clerk/backend` rejects a
// malformed key). That call is wrapped in try/catch so any init failure
// surfaces as a readable JSON 500 with the actual error message instead of
// Vercel's opaque FUNCTION_INVOCATION_FAILED.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiHandler } from '../server/dev-api.js'

type Handle = ReturnType<typeof createApiHandler>

let handle: Handle | null = null
let initError: unknown = null

try {
  handle = createApiHandler(process.env as Record<string, string>)
} catch (err) {
  initError = err
}

export default function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (initError || !handle) {
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        error: 'API failed to initialize',
        message:
          initError instanceof Error
            ? initError.message
            : String(initError ?? 'unknown'),
        stack: initError instanceof Error ? initError.stack : undefined,
      }),
    )
    return
  }

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
