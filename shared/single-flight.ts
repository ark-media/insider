// Collapse concurrent calls for the same key into one.
//
// The TTL caches (ttl-cache.ts) only hold a value once its load has finished, so
// a burst of requests landing on a cold instance all miss together and each
// makes its own upstream call — 50 simultaneous readers, 50 Beehiiv or Stripe
// requests against a quota the whole site shares. Put a load behind `run` and
// the first caller starts it; everyone who arrives while it is in flight gets
// the same promise.
//
// Holds nothing once a load settles: success is the caller's cache to keep, and
// a rejection is handed to every caller that joined it, then forgotten, so the
// next request retries rather than inheriting the failure.

export type SingleFlight<K, V> = {
  run(key: K, load: () => Promise<V>): Promise<V>
}

export function createSingleFlight<K, V>(): SingleFlight<K, V> {
  const inFlight = new Map<K, Promise<V>>()
  return {
    run(key, load) {
      const pending = inFlight.get(key)
      if (pending) return pending
      // The async wrapper turns a synchronous throw into a rejection, so the
      // entry is still cleaned up by `finally`.
      const promise = (async () => load())().finally(() => {
        inFlight.delete(key)
      })
      inFlight.set(key, promise)
      return promise
    },
  }
}
