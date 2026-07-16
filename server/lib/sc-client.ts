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

// Shared request builder for both API versions. `base` differs (v2 embeds the
// network id in the path; v1 scopes by API key), but the auth, JSON handling,
// and error shape are identical.
function buildScCall(base: string, apiKey: string) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  return async <T = unknown>(
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
}

export function createScClient(env: Env) {
  const networkId = env.SC_NETWORK_ID
  const apiKey = env.SC_API_KEY
  if (!networkId || !apiKey) {
    throw new Error('SC_NETWORK_ID and SC_API_KEY must be set in .env')
  }
  return { call: buildScCall(`https://api.supportingcast.fm/v2/${networkId}`, apiKey) }
}

export type ScClient = ReturnType<typeof createScClient>

// The v1 API (memberships, downloads) is scoped by the API key alone — no
// network id in the path. Used by the reminder cron to page through the whole
// membership roster (both checkout-provisioned and bulk-migrated members).
export function createScV1Client(env: Env) {
  const apiKey = env.SC_API_KEY
  if (!apiKey) throw new Error('SC_API_KEY must be set in .env')
  return { call: buildScCall('https://api.supportingcast.fm/v1', apiKey) }
}

export type ScV1Client = ReturnType<typeof createScV1Client>

// A v1 membership. `joined` is the signup timestamp (the reminder clock);
// `feeds` is populated only when the list is fetched with include_feeds=true.
export type ScMembership = {
  id: number
  user_id: number
  email: string
  first_name?: string
  last_name?: string
  status?: string
  joined?: string
  feeds?: ScUserFeed[]
}

type MembershipPage = {
  data?: ScMembership[]
  current_page?: number
  last_page?: number
}

// Page through GET /v1/memberships with feeds embedded, returning every
// membership. Bounded by MAX_PAGES as a runaway guard; 500/page is SC's max.
export async function loadAllMemberships(
  sc: ScV1Client,
): Promise<ScMembership[]> {
  const all: ScMembership[] = []
  const MAX_PAGES = 200
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await sc.call<MembershipPage>(
      'GET',
      `/memberships?include_feeds=true&page=${page}&max_page_size=500`,
    )
    const data = res.data ?? []
    all.push(...data)
    const last = res.last_page ?? page
    const current = res.current_page ?? page
    if (data.length === 0 || current >= last) break
  }
  return all
}

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
