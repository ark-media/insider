/**
 * Does Beehiiv's Spotify hand-off honour `redirect_path` yet?
 *
 *   bun run scripts/beehiiv-redirect-path-probe.ts
 *
 * Beehiiv documents `redirect_path` as "where the subscriber should land after
 * completing the Spotify OAuth flow — this can point back to your own site".
 * Until 2026-09-14 it did not: it was a path on the publication's own beehiiv
 * domain, and anything that could leave that host was collapsed to "/", which
 * is why members finished the flow on `arkmedia.beehiiv.com/?connected=spotify`
 * instead of back on /account/podcast-feed.
 *
 * Re-measured 2026-09-20: HTTPS absolute URLs now survive verbatim, so the
 * setup page is a same-tab round trip. HTTP and protocol-relative URLs still
 * collapse to "/". This probe is the regression check.
 *
 * You cannot see that by reading the response: `/authorize` 302s to Spotify
 * with the value sealed inside an encrypted `state` blob. But the ciphertext
 * LENGTH leaks it — a fixed baseline, plus framing, plus the stored path. So
 * send values of wildly different lengths and watch what the blob does:
 *
 *   redirect_path      kept   verdict
 *   (omitted)             0   baseline
 *   /x                    2   verbatim
 *   /a/b?c=d             36   verbatim, query and #fragment survive
 *   https://…  (246ch)  246   verbatim (was 1 — collapsed to "/" — before 2026-09-20)
 *
 * Re-run this before believing any claim that it's broken or fixed again. If
 * the absolute-URL rows shrink to 1 character, Beehiiv has regressed and the
 * FeedSetup hand-off has to go back to a new tab.
 *
 * Reads BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID_ARK_DAILY /
 * BEEHIIV_SUBSCRIBER_HOST from .env.local (bun loads it). Mints a real 30-minute
 * subscriber credential per run — it is never printed.
 */

const key = process.env.BEEHIIV_API_KEY
const pub = process.env.BEEHIIV_PUBLICATION_ID_ARK_DAILY
const host = process.env.BEEHIIV_SUBSCRIBER_HOST
const email = process.argv[2] ?? 'hannah.waxman8@gmail.com'

if (!key || !pub || !host) {
  console.error('Need BEEHIIV_API_KEY, BEEHIIV_PUBLICATION_ID_ARK_DAILY, BEEHIIV_SUBSCRIBER_HOST')
  process.exit(1)
}

const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }

const subRes = await fetch(
  `https://api.beehiiv.com/v2/publications/${pub}/subscriptions/by_email/${encodeURIComponent(email)}`,
  { headers },
)
const subscriptionId = ((await subRes.json()) as { data?: { id?: string } }).data?.id
if (!subscriptionId) {
  console.error(`No Beehiiv subscription for ${email} (${subRes.status})`)
  process.exit(1)
}

const jwtRes = await fetch(
  `https://api.beehiiv.com/v2/publications/${pub}/subscriptions/${subscriptionId}/jwt_token`,
  { headers },
)
const jwt = ((await jwtRes.json()) as { data?: { jwt_token?: string } }).data?.jwt_token
if (!jwt) {
  console.error(`JWT mint failed (${jwtRes.status}) — auto-login may be off for this publication`)
  process.exit(1)
}
const subscriberId = (
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as { subscriber_id: string }
).subscriber_id

/** Bytes of ciphertext in the OAuth `state` for a given redirect_path. */
async function stateBytes(redirectPath: string | null): Promise<number> {
  const params = new URLSearchParams({ subscriber_id: subscriberId, jwt_token: jwt! })
  if (redirectPath !== null) params.set('redirect_path', redirectPath)
  const res = await fetch(`https://${host}/oauth/spotify/authorize?${params}`, {
    redirect: 'manual',
    // Cloudflare 403s a default fetch UA on this host.
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36' },
  })
  const location = res.headers.get('location')
  if (!location) throw new Error(`no redirect from /authorize (${res.status})`)
  const state = new URL(location).searchParams.get('state')
  if (!state) throw new Error('no state on the Spotify authorize URL')
  const { data } = JSON.parse(Buffer.from(state, 'base64').toString()) as { data: string }
  return data.length / 2
}

const baseline = await stateBytes(null)
// One known-verbatim value calibrates the per-value framing, so the table below
// reads as "how many characters survived" rather than raw byte counts.
const framing = (await stateBytes('/x')) - baseline - 2

const cases = [
  '/x',
  '/account/podcast-feed',
  '/account/podcast-feed?spotify=linked',
  '/account/podcast-feed#done',
  'https://ark-plus.xyz/account/podcast-feed',
  'https://ark-plus.xyz/account/podcast-feed?spotify=linked',
  `https://ark-plus.xyz/account/podcast-feed?pad=${'a'.repeat(200)}`,
  '//ark-plus.xyz/account/podcast-feed',
  'http://ark-plus.xyz/account/podcast-feed',
  'ark-plus.xyz/account/podcast-feed',
]

console.log(`baseline ${baseline} bytes, framing ${framing} bytes\n`)
console.log('sent  kept  verdict     redirect_path')
let honoursAbsolute = false
for (const value of cases) {
  const kept = (await stateBytes(value)) - baseline - framing
  const verbatim = kept === value.length
  const collapsed = kept === 1
  if (verbatim && /^https?:\/\//.test(value)) honoursAbsolute = true
  console.log(
    `${String(value.length).padStart(4)}  ${String(kept).padStart(4)}  ` +
      `${(verbatim ? 'verbatim' : collapsed ? '→ "/"' : 'rewritten').padEnd(10)}  ${value}`,
  )
}

console.log(
  honoursAbsolute
    ? '\n✅ Absolute URLs still survive — same-tab return in FeedSetup is safe.'
    : '\n❌ Path-only on the beehiiv domain again. Revert the FeedSetup hand-off to a new tab.',
)
