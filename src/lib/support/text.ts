// Text normalisation for the help widget's FAQ search.
//
// Deliberately pure and DOM-free: `bun test` runs this without registering
// happy-dom, and it must never import src/lib/richTextPreview.ts (which uses
// DOMParser). Everything here operates on strings.
//
// The shape of this file is dictated by the corpus it indexes. Measured over
// the 33 seeded FAQs (migrations/0018_faq_content_refresh.sql):
//
//   * `subscription` appears in 28 of 33 documents. The corpus is topically
//     homogeneous, so the discriminating power lives in rare terms and the
//     scorer leans hard on IDF (see search.ts).
//   * The token `ads` appears ZERO times — the corpus only ever writes the
//     hyphenated adjective `ad-free` (9 documents). Without hyphen splitting
//     plus an `ads -> ad` stem, "I'm still hearing ads" scores exactly nothing
//     against every FAQ. That is why both exist.

/** Words that carry no retrieval signal. Grammatical function words only. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'cant',
  'could', 'did', 'do', 'does', 'doing', 'dont', 'for', 'get', 'got', 'had',
  'has', 'have', 'how', 'i', 'id', 'if', 'ill', 'im', 'in', 'into', 'is', 'it',
  'its', 'ive', 'just', 'me', 'my', 'need', 'not', 'of', 'on', 'or', 'our',
  'so', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'too', 'was', 'we', 'were', 'will', 'with', 'would', 'you',
  'your', 'yours',
])

// Most of the interrogatives — what / where / when / who / why / which — are
// POINTEDLY absent too, and this is the least obvious call in the file.
// (`how` stays stopped: it opens the majority of the questions, so it carries
// almost no signal, and "how much" survives via the bigram layer anyway.) In
// ordinary prose they are pure noise. In a corpus whose highest-weighted field
// is literally a list of questions, they are part of each question's identity:
// "How do I know WHERE I'm subscribed?" and "WHERE can I subscribe, and how
// much does it cost?" are distinguished from the other 31 documents largely by
// them. Stopping them collapsed "where am I subscribed" to the single term
// `subscribe` (which 28 of 33 documents contain) and the query matched an
// unrelated FAQ. Leave them in and let IDF price them.

// `to` and `from` are POINTEDLY absent from that list. "Can I switch my
// subscription TO Apple" and "Can I move my subscription FROM Apple to the
// website" are lexical mirror images whose only distinguishing signal is the
// preposition. Their IDF is ~0 so they cost nothing as unigrams, and they carry
// the pair in the bigram layer. Do not "tidy" them into STOPWORDS.

/**
 * Inflections that actually occur in this corpus and in the ways members
 * phrase questions about it. A hand map rather than Porter: at N=33 an
 * over-eager stemmer's false conflations (`during` -> `dur`, `feed` -> `fe`)
 * cost more than its recall gains, and this table is auditable at a glance.
 */
const STEMS = new Map(Object.entries({
  // Identity entries: the product tokens minted by normalizeText() end in `s`
  // and would otherwise be mauled by the generic plural rule into `arkplu` and
  // `applepodcast`. Consistent mangling would still match, but these are the
  // highest-traffic terms in the corpus and they should stay readable in the
  // index, in test failures, and in the no-results log.
  arkplus: 'arkplus',
  applepodcasts: 'applepodcasts',
  pocketcasts: 'pocketcasts',
  arkmedia: 'arkmedia',
  callmeback: 'callmeback',

  ads: 'ad',
  apps: 'app',
  benefits: 'benefit',
  billed: 'bill',
  billing: 'bill',
  canceled: 'cancel',
  cancelled: 'cancel',
  cancelling: 'cancel',
  cancels: 'cancel',
  charged: 'charge',
  charges: 'charge',
  charging: 'charge',
  episodes: 'episode',
  listening: 'listen',
  listens: 'listen',
  paid: 'pay',
  paying: 'pay',
  pays: 'pay',
  payments: 'payment',
  purchased: 'purchase',
  purchases: 'purchase',
  purchasing: 'purchase',
  renewal: 'renew',
  renewals: 'renew',
  renewing: 'renew',
  renews: 'renew',
  subscribed: 'subscribe',
  subscriber: 'subscribe',
  subscribers: 'subscribe',
  subscribing: 'subscribe',
  subscription: 'subscribe',
  subscriptions: 'subscribe',
  switched: 'switch',
  switches: 'switch',
  switching: 'switch',
}))

/** Plural folding for everything the map doesn't name explicitly. */
function stem(word: string): string {
  const mapped = STEMS.get(word)
  if (mapped) return mapped
  if (word.length <= 3) return word
  if (/(xes|ses|zes|ches|shes)$/.test(word)) return word.slice(0, -2)
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

/**
 * Strips HTML for indexing. Attribute values are DROPPED and anchor text kept.
 *
 * This matters: FAQ answers carry `mailto:support@arkmedia.org` and
 * `support.apple.com/billing` hrefs. Indexing those injects `mailto`, `support`,
 * `apple`, `com`, `billing` and `arkmedia` as tokens and turns unrelated rows
 * into magnets for a query like "support". A tag becomes a space so that
 * `<li>Ad-free</li><li>Early access` doesn't fuse into `adfreeEarly`.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Folds a raw string into a canonical lowercase form, collapsing the product
 * names that would otherwise shatter into high-frequency noise.
 *
 * The product pass runs BEFORE punctuation is stripped, which is the whole
 * point: `ark+` would otherwise lose its `+` and collide with the bare word
 * `ark`, and "Call Me Back" would become three of the most common and least
 * useful tokens in the corpus.
 */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // Fold typographic punctuation BEFORE apostrophes are dropped, or `cant`
    // will never match a curly-quoted `can't`.
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase()
    .replace(/\bark\s*\+/g, ' arkplus ')
    .replace(/\bark[\s-]?plus\b/g, ' arkplus ')
    .replace(/\bark[\s-]?media\b/g, ' arkmedia ')
    .replace(/\bcall\s*me\s*back\b/g, ' callmeback ')
    .replace(/\bapple\s*podcasts?\b/g, ' applepodcasts ')
    .replace(/\bpocket\s*casts\b/g, ' pocketcasts ')
    .replace(/\bitunes\b/g, ' applepodcasts ')
    // Intra-word apostrophes vanish so don't/dont and I'm/im are one token.
    .replace(/([a-z])'([a-z])/g, '$1$2')
}

/**
 * Normalised string -> scoring tokens. A hyphenated word emits BOTH the joined
 * form and each part (`ad-free` -> `adfree`, `ad`, `free`), which is what lets
 * a query for "ads" reach the nine `ad-free` documents.
 */
export function tokenize(input: string): string[] {
  const words = normalizeText(input).split(/[^a-z0-9-]+/)
  const out: string[] = []

  const push = (word: string) => {
    if (word.length < 2) return
    if (STOPWORDS.has(word)) return
    // Check the stopword list on BOTH sides of stemming. Before, because
    // `does` would otherwise stem to `doe` and escape; after, because `whats`
    // is not itself listed but stems to `what`, which is.
    const stemmed = stem(word)
    if (STOPWORDS.has(stemmed)) return
    out.push(stemmed)
  }

  for (const word of words) {
    if (!word) continue
    if (word.includes('-')) {
      const parts = word.split('-').filter(Boolean)
      if (parts.length > 1) push(parts.join(''))
      for (const part of parts) push(part)
    } else {
      push(word)
    }
  }
  return out
}

/** Adjacent token pairs, for the phrase layer in search.ts. */
export function bigrams(tokens: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < tokens.length; i += 1) out.push(`${tokens[i - 1]} ${tokens[i]}`)
  return out
}

/** Damerau-Levenshtein distance, capped: returns `max + 1` once it exceeds it. */
export function editDistance(a: string, b: string, max = 1): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let curr: number[] = []
  for (let i = 1; i <= a.length; i += 1) {
    curr = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
      // Transposition (the "Damerau" half) — `sotify` -> `spotify`.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1)
      }
      curr[j] = v
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev2 = prev
    prev = curr
  }
  return prev[b.length]
}
