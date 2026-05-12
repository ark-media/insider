// Tiny in-memory TTL cache. Per-process — gone on cold start. Use behind
// HTTP cache headers (s-maxage / SWR) so the edge cache absorbs traffic
// between warm instances; this layer just deduplicates concurrent upstream
// calls on a single function instance.

export type TTLCache<K, V> = {
  get(key: K): V | null
  set(key: K, value: V): void
  clear(): void
}

export function makeTTLCache<K, V>(ttlMs: number): TTLCache<K, V> {
  const store = new Map<K, { at: number; value: V }>()
  return {
    get(key) {
      const hit = store.get(key)
      if (!hit) return null
      if (Date.now() - hit.at >= ttlMs) {
        store.delete(key)
        return null
      }
      return hit.value
    },
    set(key, value) {
      store.set(key, { at: Date.now(), value })
    },
    clear() {
      store.clear()
    },
  }
}
