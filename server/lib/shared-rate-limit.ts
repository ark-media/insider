// Token-bucket rate limiter shared across function instances.
//
// `createRateLimiter` (rate-limit.ts) keeps its buckets in process memory, so on
// Vercel every instance has its own and a cold start resets them: fan a script
// out across instances and the limit multiplies. That is fine for the
// authenticated routes, where the caller is already a known member. It is not
// fine for the unauthenticated routes that spend money or send mail on each call
// (checkout creation, the contact form, the newsletter subscribe, gift status),
// so those take their tokens from one row in Neon instead.
//
// One upsert per take, atomic in Postgres — concurrent takes on the same key
// serialise on the row, so the bucket can't be overdrawn by a race.
//
// Fails OPEN to an in-memory bucket of the same shape: a database blip must not
// take checkout down, and the per-instance limit is still a limit. Without
// DATABASE_URL (local dev, most tests) it is that in-memory bucket outright.
//
// Keys routinely carry an IP or an email. The table stores their SHA-256, never
// the key itself.

import crypto from 'node:crypto'
import { getDb } from './db.js'
import { createRateLimiter } from './rate-limit.js'

export type SharedRateLimiter = {
  /** Resolves null if allowed, or the seconds the caller should wait. */
  take: (key: string) => Promise<number | null>
}

// A bucket untouched for this long has refilled whatever its shape, so the row
// carries no information and can go.
const STALE_AFTER = '2 days'
// Prune on roughly one take in a hundred rather than on a cron: the table stays
// small without a seventh scheduled job to own it.
const PRUNE_CHANCE = 0.01

export function createSharedRateLimiter(
  env: Record<string, string>,
  opts: {
    // Namespaces the bucket, so two limiters keyed on the same IP don't share
    // tokens. Must be unique per limiter.
    name: string
    capacity: number
    refillPerSec: number
  },
): SharedRateLimiter {
  const { name, capacity, refillPerSec } = opts
  const local = createRateLimiter({ capacity, refillPerSec })

  return {
    async take(key) {
      if (!env.DATABASE_URL) return local.take(key)

      const hashed = crypto.createHash('sha256').update(`${name}|${key}`).digest('hex')
      try {
        const sql = getDb(env)
        // `refilled` is what the bucket holds now, before this take. The row is
        // written with the token spent only when there was one to spend, and
        // `allowed` records which it was — the post-take balance alone can't
        // say (0.5 is both "had 1.5, spent one" and "had 0.5, refused").
        const rows = (await sql`
          insert into rate_limit_buckets as b (key, tokens, allowed, updated_at)
          values (${hashed}, ${capacity - 1}, true, now())
          on conflict (key) do update set
            tokens = case
              when least(${capacity}::float8,
                         b.tokens + extract(epoch from (now() - b.updated_at)) * ${refillPerSec}::float8) >= 1
              then least(${capacity}::float8,
                         b.tokens + extract(epoch from (now() - b.updated_at)) * ${refillPerSec}::float8) - 1
              else least(${capacity}::float8,
                         b.tokens + extract(epoch from (now() - b.updated_at)) * ${refillPerSec}::float8)
            end,
            allowed = least(${capacity}::float8,
                            b.tokens + extract(epoch from (now() - b.updated_at)) * ${refillPerSec}::float8) >= 1,
            updated_at = now()
          returning tokens, allowed`) as { tokens: number; allowed: boolean }[]

        if (Math.random() < PRUNE_CHANCE) {
          // Best effort, and deliberately not awaited into the caller's latency
          // budget beyond this one statement; a failure here is only a bigger table.
          await sql`
            delete from rate_limit_buckets
            where updated_at < now() - ${STALE_AFTER}::interval`.catch(() => {})
        }

        const row = rows[0]
        if (!row || row.allowed) return null
        return Math.max(1, Math.ceil((1 - Number(row.tokens)) / refillPerSec))
      } catch (err) {
        console.error('[rate-limit] shared bucket unavailable, using in-memory:', err)
        return local.take(key)
      }
    },
  }
}
