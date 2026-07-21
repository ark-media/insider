import { afterAll, beforeEach } from 'bun:test'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from 'jose'
import {
  AUTH0_AUDIENCE,
  AUTH0_EMAIL_CLAIM,
  AUTH0_ROLES_CLAIM,
} from '../shared/auth0-claims'

// ---------------------------------------------------------------------------
// Neon mock scaffolding
//
// The resolver-style suites all install the same tagged-template fake: record
// every query into a `calls` array, then resolve rows via a mutable
// `nextSqlResult(sql)` the test reassigns per-case. Only that scaffolding is
// shared — each file keeps its own `calls`/`nextSqlResult` bindings and its
// per-query result logic. Usage:
//   mock.module('@neondatabase/serverless', () =>
//     neonMockModule(sqlCalls, (sql) => nextSqlResult(sql)))
// The `next` closure is invoked per call, so reassigning `nextSqlResult` between
// cases takes effect without rebuilding the mock.
// ---------------------------------------------------------------------------

export type SqlCall = { sql: string; values: unknown[] }

export function neonMockModule(
  calls: SqlCall[],
  next: (sql: string, values: unknown[]) => unknown,
): { neon: unknown; __esModule: true } {
  return {
    neon: (_url: string) =>
      ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const merged = strings.join('?')
        calls.push({ sql: merged, values })
        return Promise.resolve(next(merged, values))
      }) as unknown,
    __esModule: true,
  }
}

// ---------------------------------------------------------------------------
// devApiPlugin test harness
//
// Every route suite drives handlers through the same three primitives — a fake
// Node req stream, a capturing res, and a promise that resolves on res.end —
// plus a fake Vite server that captures the plugin's registered middlewares.
// These were hand-copied (near-verbatim) into ~30 files; the shared versions
// below are a superset of every local variant so a file can delete its copy.
// ---------------------------------------------------------------------------

export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void

// A capturing ServerResponse: `__json()`/`__body()` read what the handler wrote,
// `__headers()` the (lowercased) response headers.
export type FakeRes = ServerResponse & {
  __body: () => string
  __json: () => unknown
  __headers: () => Record<string, string>
}

export type MakeReqOpts = {
  method?: string
  url?: string
  // Object → JSON-stringified; string/Buffer → passed through verbatim (webhook
  // signature suites need the exact raw bytes). Absent → empty body.
  body?: unknown
  bearer?: string
  cookie?: string
  headers?: Record<string, string>
  remoteAddress?: string
}

export function makeFakeReq(opts: MakeReqOpts = {}): IncomingMessage {
  const { body } = opts
  const raw =
    body === undefined
      ? Buffer.alloc(0)
      : typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body), 'utf8')
  const stream = Readable.from([raw]) as unknown as Omit<IncomingMessage, 'socket'> & {
    method?: string
    url?: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  stream.method = opts.method ?? 'GET'
  stream.url = opts.url ?? '/'
  stream.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  if (opts.bearer) stream.headers['authorization'] = `Bearer ${opts.bearer}`
  if (opts.cookie) stream.headers['cookie'] = opts.cookie
  stream.socket = { remoteAddress: opts.remoteAddress ?? '127.0.0.1' }
  return stream as unknown as IncomingMessage
}

export function makeFakeRes(): FakeRes {
  const headers: Record<string, string> = {}
  let body = ''
  let statusCode = 200
  let ended = false
  return {
    get statusCode() {
      return statusCode
    },
    set statusCode(v: number) {
      statusCode = v
    },
    get headersSent() {
      return ended
    },
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value)
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()]
    },
    end(chunk?: string | Buffer) {
      if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString()
      ended = true
    },
    __body: () => body,
    __json: () => JSON.parse(body) as unknown,
    __headers: () => headers,
  } as unknown as FakeRes
}

// Runs a middleware and resolves once it writes a response (res.end), or rejects
// if it calls next(err)/throws. Wraps res.end so the promise settles exactly
// when the handler finishes. Accepts any ServerResponse (it only touches
// `end`), so files keeping a bespoke capturing res can still use it.
export function runMiddleware(
  handler: Middleware,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const origEnd = res.end.bind(res)
    ;(res as unknown as { end: typeof origEnd }).end = ((
      chunk?: string | Buffer,
    ) => {
      origEnd(chunk as string | Buffer)
      resolve()
      return res
    }) as typeof origEnd
    try {
      handler(req, res as ServerResponse, (err) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// Registers a devApiPlugin's middlewares against a fake Vite server (once) and
// exposes handler lookup + a one-call `call(path, opts)` that builds the req/res
// and runs it. Pass `devApiPlugin(env)` — constructed in the test file *after*
// its mock.module so mocks stay in effect. A file needing a different env just
// makes a 2nd harness with a 2nd `devApiPlugin(otherEnv)`.
export function createDevApiHarness(plugin: { configureServer?: unknown }): {
  handlers: Map<string, Middleware>
  getHandler: (path: string) => Middleware
  call: (path: string, opts?: MakeReqOpts) => Promise<FakeRes>
} {
  const handlers = new Map<string, Middleware>()
  const fakeServer = {
    middlewares: {
      use(path: string, handler: Middleware) {
        handlers.set(path, handler)
      },
    },
  }
  ;(plugin.configureServer as unknown as (s: unknown) => void)(fakeServer)

  function getHandler(path: string): Middleware {
    const h = handlers.get(path)
    if (!h) throw new Error(`handler not registered for ${path}`)
    return h
  }

  async function call(path: string, opts: MakeReqOpts = {}): Promise<FakeRes> {
    const res = makeFakeRes()
    await runMiddleware(getHandler(path), makeFakeReq({ url: path, ...opts }), res)
    return res
  }

  return { handlers, getHandler, call }
}

/**
 * Silences console.error/warn for the calling test file. Several suites
 * deliberately drive error and fallback paths (upstream 500s, missing config)
 * whose handlers log via console.error/warn — expected behavior, but it dumps
 * stack traces into an otherwise-green run. Call once at module scope; it
 * registers its own beforeEach/afterAll so the originals are restored after the
 * file finishes (other test files keep their console intact).
 */
export function silenceExpectedConsole() {
  const originalError = console.error
  const originalWarn = console.warn
  beforeEach(() => {
    console.error = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.error = originalError
    console.warn = originalWarn
  })
}

// jose's createRemoteJWKSet caches keys process-wide keyed on the JWKS URL.
// Every test file that signs Auth0 tokens hits the same URL, so if two files
// each generated their own keypair the first to run would seed the cache and
// the second file's tokens would fail to verify. One shared keypair avoids it.
export const AUTH0_TEST_DOMAIN = 'https://auth.ark-plus.xyz'
export const AUTH0_TEST_JWKS_URL = `${AUTH0_TEST_DOMAIN}/.well-known/jwks.json`
export const AUTH0_TEST_KID = 'shared-test-key'

let cached: { privateKey: CryptoKey; publicJwk: JWK } | null = null

export async function getAuth0TestKeys(): Promise<{
  privateKey: CryptoKey
  publicJwk: JWK
}> {
  if (cached) return cached
  const { publicKey, privateKey } = await generateKeyPair('RS256', {
    extractable: true,
  })
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    use: 'sig',
    alg: 'RS256',
    kid: AUTH0_TEST_KID,
  }
  cached = { privateKey, publicJwk }
  return cached
}

// Auth0 no longer carries a tier claim (task 5); entitlement is a Neon read
// keyed on the token `sub`. Tests set `sub` to control which membership row the
// resolver reads. `roles` drives the admin gate.
export async function signAuth0TestToken(claims: {
  email: string
  sub?: string
  roles?: string[]
}): Promise<string> {
  const { privateKey } = await getAuth0TestKeys()
  const payload: Record<string, unknown> = {
    [AUTH0_EMAIL_CLAIM]: claims.email,
  }
  if (claims.roles) payload[AUTH0_ROLES_CLAIM] = claims.roles
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: AUTH0_TEST_KID })
    .setIssuer(`${AUTH0_TEST_DOMAIN}/`)
    .setAudience(AUTH0_AUDIENCE)
    .setSubject(claims.sub ?? `auth0|${claims.email}`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

// The JWKS response jose's createRemoteJWKSet expects at AUTH0_TEST_JWKS_URL.
// Fetch mocks that verify Auth0 bearers all serve this same body:
//   if (url === AUTH0_TEST_JWKS_URL) return jwksResponse()
export async function jwksResponse(): Promise<Response> {
  const { publicJwk } = await getAuth0TestKeys()
  return new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// Parse a fetch mock's captured request body: JSON when it's a JSON string,
// the raw string when it isn't, undefined when there's no string body. Mirrors
// the try/JSON.parse snippet every capturing fetch mock hand-rolled.
export function parseJsonInitBody(init?: RequestInit): unknown {
  if (init?.body && typeof init.body === 'string') {
    try {
      return JSON.parse(init.body)
    } catch {
      return init.body
    }
  }
  return undefined
}
