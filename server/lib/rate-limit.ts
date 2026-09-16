// Token-bucket rate limiter.
//
// In-memory only — sufficient for a single-process dev server or a single
// hot serverless instance. For multi-process production, swap for Redis
// or rely on a WAF / API gateway upstream; buckets here are not shared.

type Bucket = { tokens: number; updatedAt: number }

export type RateLimiter = {
  /** Returns null if allowed, or the seconds the caller should wait. */
  take: (key: string) => number | null
}

export function createRateLimiter(opts: {
  capacity: number
  refillPerSec: number
  maxKeys?: number
}): RateLimiter {
  const { capacity, refillPerSec } = opts
  const maxKeys = opts.maxKeys ?? 10_000
  const buckets = new Map<string, Bucket>()

  const prune = (now: number) => {
    for (const [k, b] of buckets) {
      const refilled = Math.min(
        capacity,
        b.tokens + ((now - b.updatedAt) / 1000) * refillPerSec,
      )
      if (refilled >= capacity) buckets.delete(k)
    }
  }

  return {
    take(key) {
      const now = Date.now()
      let b = buckets.get(key)
      if (!b) {
        b = { tokens: capacity, updatedAt: now }
        buckets.set(key, b)
        if (buckets.size > maxKeys) prune(now)
      } else {
        const elapsedSec = (now - b.updatedAt) / 1000
        b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec)
        b.updatedAt = now
      }
      if (b.tokens >= 1) {
        b.tokens -= 1
        return null
      }
      const needed = 1 - b.tokens
      return Math.ceil(needed / refillPerSec)
    },
  }
}
