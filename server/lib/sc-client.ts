// Supporting Cast (SC) HTTP client. Network id + API key live on the server
// only. Errors carry the upstream HTTP status so callers can branch on
// well-known codes (404 → no record yet, 422 → validation, 429 → rate limit).

type Env = Record<string, string>

export type ScError = Error & { status?: number; data?: unknown }

export type ScUser = {
  id: number
  email: string
  first_name?: string
  last_name?: string
}

export type ScUserFeed = {
  id: number
  name: string
  url: string
  description?: string
  image_url?: string
  apps?: Array<{ app: string; name: string; url: string }>
}

export function createScClient(env: Env) {
  const networkId = env.SC_NETWORK_ID
  const apiKey = env.SC_API_KEY
  if (!networkId || !apiKey) {
    throw new Error('SC_NETWORK_ID and SC_API_KEY must be set in .env')
  }
  const base = `https://api.supportingcast.fm/v2/${networkId}`
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const call = async <T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: { idempotencyKey?: string },
  ): Promise<T> => {
    const reqHeaders: Record<string, string> = { ...headers }
    if (opts?.idempotencyKey) {
      // Honored by SC when present; harmless when not. Used by the activator
      // to dedupe POST /subscriptions across concurrent serverless instances
      // racing on the same Stripe subscription.
      reqHeaders['Idempotency-Key'] = opts.idempotencyKey
    }
    const r = await fetch(`${base}${path}`, {
      method,
      headers: reqHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await r.text()
    const data = text ? (JSON.parse(text) as unknown) : null
    if (!r.ok) {
      const err: ScError = Object.assign(
        new Error(`SC ${method} ${path} failed: ${r.status}`),
        { status: r.status, data },
      )
      throw err
    }
    return data as T
  }
  return { call }
}

export type ScClient = ReturnType<typeof createScClient>

export async function findScUserByEmail(
  sc: ScClient,
  email: string,
): Promise<ScUser | null> {
  // `family: 'all'` searches the parent + child networks. Without it, a user
  // that exists on the parent network is invisible here, but POST /users
  // still rejects the email as taken — producing a confusing 422.
  const res = await sc.call<{ users?: ScUser[] }>('POST', '/users/search', {
    email,
    family: 'all',
  })
  return res.users?.[0] ?? null
}

export async function findOrCreateScUser(
  sc: ScClient,
  email: string,
  nameHint?: string,
): Promise<ScUser> {
  const existing = await findScUserByEmail(sc, email)
  if (existing) return existing
  const first = (nameHint || email.split('@')[0] || 'Member').slice(0, 40)
  const created = await sc.call<{ user: ScUser }>('POST', '/users', {
    email,
    first_name: first,
    last_name: '',
  })
  return created.user
}
