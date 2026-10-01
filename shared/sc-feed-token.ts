// The token in a Supporting Cast personalised feed URL,
// https://inside.arkmedia.org/content/<token>.rss.
//
// The token is ONE base64url string that decodes to `<json>|<hex hmac>`, where
// the JSON is {"t":"p","c":"<feed id>","u":"<sc user id>","d":"<unix seconds
// issued>","k":…}. The bar is inside the encoding, not in the URL. We cannot
// verify the signature (SC's key) and do not need to: the redirect only needs
// `u` to find the member, and the feed it lands on is minted by Beehiiv for
// that member's email — a forged `u` earns a stranger's redirect to a URL that
// is already theirs, nothing more.

export type ScFeedToken = {
  /** SC feed/content id — the `c` field. */
  feedId: string
  /** SC user id — the `u` field; the key into sc_feed_members. */
  userId: string
  /** When the token was issued, from `d`; null when absent or unreadable. */
  issuedAt: Date | null
}

// Accepts the bare token, or a whole feed URL / path (anything that carries
// `/content/<token>.rss`). Returns null when the input is not an SC token.
export function decodeScFeedToken(input: string): ScFeedToken | null {
  const m = input.match(/\/content\/([^/?#]+)\.rss/)
  const raw = m ? m[1]! : input.replace(/\.rss$/, '')
  if (!raw || !/^[A-Za-z0-9_%=-]+$/.test(raw)) return null
  let decoded: string
  try {
    decoded = Buffer.from(decodeURIComponent(raw), 'base64url').toString('utf8')
  } catch {
    return null
  }
  const json = decoded.split('|')[0]
  if (!json) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { c, u, d } = parsed as Record<string, unknown>
  const userId = String(u ?? '')
  if (!/^\d+$/.test(userId)) return null
  const seconds = Number(d)
  const issuedAt =
    Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null
  return { feedId: String(c ?? ''), userId, issuedAt }
}
