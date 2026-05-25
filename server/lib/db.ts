// Neon Postgres client. The back office (announcements) is the only feature
// with mutable server state, so this stays deliberately thin — a single
// `neon()` HTTP client built from DATABASE_URL. No ORM: callers write SQL with
// the tagged-template API, which parameterizes interpolated values (so a
// `${userInput}` is bound, never concatenated).
//
// The HTTP driver is stateless and connectionless, which suits both the Vite
// dev middleware and the single Vercel Node Function in prod — no pool to keep
// warm across cold starts. Use the pooled DATABASE_URL (…-pooler.…).

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

// The default `neon()` client (rows-array results, no array mode). Spelled out
// rather than `ReturnType<typeof neon>`, which widens the generics to `boolean`
// and won't accept the concrete `<false, false>` client.
export type Sql = NeonQueryFunction<false, false>

let cached: { url: string; sql: Sql } | null = null

// Reused across invocations in a long-running process; rebuilt only if the URL
// changes (e.g. tests swapping env). Throws a readable error when unset so the
// route surfaces a 500 with a clear message rather than a driver-internal one.
export function getDb(env: Record<string, string>): Sql {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not configured')
  if (cached && cached.url === url) return cached.sql
  const sql = neon(url)
  cached = { url, sql }
  return sql
}
