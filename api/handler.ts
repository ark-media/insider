// ---------------------------------------------------------------------------
// Vercel serverless function — single handler for all /api/* requests.
//
// Vercel's file-based dynamic routing (`api/[...path].ts`) only matched
// single-segment paths in this non-Next.js project, so routing goes through
// an explicit `vercel.json` rewrite instead: every /api/* is rewritten to
// /api/handler with the original path carried in the `_vpath` query param.
// We strip `_vpath` back out and hand `createApiHandler` the URL it expects.
//
// Init uses a dynamic import inside a try/catch so BOTH import-time failures
// (e.g. a dependency that throws at load) AND construction-time failures
// (e.g. Clerk rejecting a malformed key) surface as a readable JSON 500
// instead of Vercel's opaque FUNCTION_INVOCATION_FAILED. A static top-level
// `import` would crash the function before the try/catch could run.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http'

type Handle = (req: IncomingMessage, res: ServerResponse) => Promise<void>

let handle: Handle | null = null
let initError: unknown = null
let initPromise: Promise<void> | null = null

async function ensureInit(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const mod = await import('../server/dev-api')
      handle = mod.createApiHandler(process.env as Record<string, string>)
    } catch (err) {
      initError = err
    }
  })()
  return initPromise
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  await ensureInit()

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
