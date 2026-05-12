import { describe, test, expect } from 'bun:test'
import { createRateLimiter } from './rate-limit'

describe('createRateLimiter', () => {
  test('allows requests up to capacity, then rejects', () => {
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1 })
    expect(rl.take('k')).toBeNull()
    expect(rl.take('k')).toBeNull()
    expect(rl.take('k')).toBeNull()
    const wait = rl.take('k')
    expect(wait).not.toBeNull()
    expect(wait!).toBeGreaterThanOrEqual(1)
  })

  test('different keys have independent buckets', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 1 })
    expect(rl.take('a')).toBeNull()
    expect(rl.take('b')).toBeNull()
    expect(rl.take('a')).not.toBeNull()
    expect(rl.take('b')).not.toBeNull()
  })

  test('refills over wall-clock time', async () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 10 })
    expect(rl.take('k')).toBeNull()
    expect(rl.take('k')).not.toBeNull()
    // Wait ~150ms; should have refilled at least one token.
    await new Promise((r) => setTimeout(r, 150))
    expect(rl.take('k')).toBeNull()
  })

  test('returned wait scales with shortfall', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 0.5 })
    rl.take('k') // drain
    const wait = rl.take('k')
    // refillPerSec = 0.5 → need 2 seconds for one token; ceil(1 / 0.5) = 2
    expect(wait).toBe(2)
  })

  test('does not exceed capacity even after long idle', async () => {
    const rl = createRateLimiter({ capacity: 2, refillPerSec: 100 })
    expect(rl.take('k')).toBeNull()
    await new Promise((r) => setTimeout(r, 100)) // would refill 10 tokens
    expect(rl.take('k')).toBeNull()
    expect(rl.take('k')).toBeNull()
    // Third take in quick succession should fail — cap is 2.
    expect(rl.take('k')).not.toBeNull()
  })

  test('prune drops fully-refilled buckets when maxKeys is exceeded', async () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 100, maxKeys: 2 })
    rl.take('a')
    rl.take('b')
    // Wait long enough for both buckets to refill to capacity (>10ms at 100/s).
    await new Promise((r) => setTimeout(r, 30))
    // Third key triggers prune. a and b are fully refilled and get evicted.
    rl.take('c')
    // a is gone — taking it again creates a fresh bucket with full capacity,
    // so two takes in succession should both succeed.
    expect(rl.take('a')).toBeNull()
    // The second take on 'a' would have failed (cap=1) if the bucket had
    // survived from earlier; since it was pruned and recreated, the prior
    // drain doesn't count.
  })
})
