// BM25F ranking over the published FAQs, for the help widget.
//
// Pure and DOM-free by design (see ./text.ts). The caller supplies the data
// tables, so this module can be tested against fixtures without importing the
// widget or its curated content.
//
// WHY BM25 AND NOT WEIGHTED OVERLAP
// The usual instinct at N=32 is "IDF is noisy on a tiny corpus, just count
// overlapping words". That is exactly backwards here. This corpus is topically
// homogeneous — every document is about subscriptions, Apple, Spotify, feeds
// and billing, and `subscribe` alone appears in 31 of the 32. Unweighted
// overlap therefore makes almost every query match almost every document. IDF
// computed over these 32 documents is not an approximation of a language model;
// it is a direct measurement of which of the words you typed actually narrow
// the corpus down. Per-field length normalisation earns its place for the same
// reason: answers run from ~12 to ~120 words, and without it the three longest
// answers win nearly every query on surface area alone.

import type { Faq } from '../faqs'
import { bigrams, editDistance, normalizeText, stripHtml, tokenize } from './text'

const FIELDS = ['question', 'aliases', 'category', 'answer'] as const
type Field = (typeof FIELDS)[number]

/**
 * A member restates the QUESTION, not the answer — hence the 3x. Aliases sit
 * just below: they are curated bridges from member vocabulary to corpus
 * vocabulary, so they should be nearly as authoritative as the real question
 * text without overriding it. Category is held low on purpose: one of the five
 * section headings is an entire sentence ("I am already subscribed to Inside
 * Call Me Back. What does this mean for me?"), and weighting it up would make
 * every FAQ in that section a magnet for generic phrasing.
 */
const FIELD_WEIGHTS: Record<Field, number> = {
  question: 3,
  aliases: 2.5,
  category: 1,
  answer: 1,
}

const K1 = 1.2
// 0.6 rather than the customary 0.75: several answers are legitimately complete
// in one sentence ("Yes, the annual subscription comes with a discount."), and
// full length normalisation over-rewards them into the top slot.
const B = 0.6

/**
 * How much IDF a document must actually match before we are willing to show it.
 *
 * This replaced a "did any matched term appear in <= 8 of 33 documents" flag,
 * which turned out to be the wrong instrument: `what` sits at df=8 and so
 * counted as distinctive, making "what is the weather" a confident answer,
 * while `community` (df=12) and `app` (df=16) individually did not, so
 * "how do I get into the community app" — a perfectly good query — matched
 * nothing. Summed IDF gets both right, because two moderately common terms
 * together are real evidence and one common term alone is not.
 */
const MIN_IDF_MASS = 1.5

/**
 * Above this share of query terms being absent from the corpus entirely, the
 * question is about something we simply do not cover. "what is the weather"
 * resolves `what` and drops `weather`; the half we dropped was the whole
 * question. Cheap, and it doesn't lean on the IDF margin being wide.
 */
const MAX_OOV_RATIO = 0.5

const PHRASE_BONUS: Record<Field, number> = {
  question: 0.6,
  aliases: 0.6,
  category: 0.2,
  answer: 0.3,
}

/**
 * Near-verbatim questions should be deterministic, not merely well-ranked.
 * A containment match ("where can I subscribe" inside "Where can I subscribe,
 * and how much does it cost?") is far stronger evidence than a similar bag of
 * tokens, so the two are scored separately — with containment big enough to
 * beat a heavily-aliased neighbour that happens to share the same words.
 */
const CONTAINS_QUESTION_BONUS = 5
const SIMILAR_QUESTION_BONUS = 2
const EXACT_MATCH_JACCARD = 0.6

type DocFields = Record<Field, { tokens: string[]; counts: Map<string, number>; bigrams: Set<string> }>

type IndexedDoc = {
  faq: Faq
  fields: DocFields
  /** Tokens present in any field — used for df and for coverage. */
  terms: Set<string>
}

export type SupportIndex = {
  docs: IndexedDoc[]
  df: Map<string, number>
  vocab: string[]
  vocabSet: Set<string>
  avgLen: Record<Field, number>
  size: number
}

type SupportHit = { faq: Faq; score: number; coverage: number }

export type SupportSearchResult = {
  /**
   * `unanswerable` means the corpus provably has no answer — escalate, never
   * guess. `no-match` means we found nothing good enough to show; the panel
   * still has `intents` to fall back on.
   */
  kind: 'unanswerable' | 'confident' | 'uncertain' | 'no-match'
  hits: SupportHit[]
  /**
   * Curated intents the query matched, best first. Carried even when there are
   * no hits: several intents (gifting, promo codes, refunds) have no FAQ at
   * all, so the topic card IS the answer.
   */
  intents: string[]
}

function emptyFieldIndex() {
  return { tokens: [] as string[], counts: new Map<string, number>(), bigrams: new Set<string>() }
}

function indexField(text: string): DocFields[Field] {
  const tokens = tokenize(text)
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
  return { tokens, counts, bigrams: new Set(bigrams(tokens)) }
}

/**
 * Builds the searchable index.
 *
 * `aliasTextByKey` maps an FAQ's stable `key` to the curated member phrasings
 * bound to it. FAQs without a key simply get no alias field — they are still
 * fully searchable on their own text.
 */
export function buildSupportIndex(
  faqs: Faq[],
  aliasTextByKey: Map<string, string> = new Map(),
): SupportIndex {
  const docs: IndexedDoc[] = faqs.map((faq) => {
    const fields = {
      question: indexField(faq.question),
      aliases: faq.key ? indexField(aliasTextByKey.get(faq.key) ?? '') : emptyFieldIndex(),
      category: indexField(faq.category),
      answer: indexField(stripHtml(faq.answer)),
    } satisfies DocFields
    const terms = new Set<string>()
    for (const f of FIELDS) for (const t of fields[f].tokens) terms.add(t)
    return { faq, fields, terms }
  })

  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of doc.terms) df.set(term, (df.get(term) ?? 0) + 1)
  }

  const avgLen = {} as Record<Field, number>
  for (const f of FIELDS) {
    const total = docs.reduce((n, d) => n + d.fields[f].tokens.length, 0)
    // Guard the divisor: an all-empty field (no FAQ has a category) must not
    // produce NaN scores for every document.
    avgLen[f] = docs.length ? Math.max(total / docs.length, 1) : 1
  }

  const vocab = [...df.keys()]
  return { docs, df, vocab, vocabSet: new Set(vocab), avgLen, size: docs.length }
}

function idf(index: SupportIndex, term: string): number {
  const n = index.df.get(term) ?? 0
  if (n === 0) return 0
  return Math.log(1 + (index.size - n + 0.5) / (n + 0.5))
}

/** A query term, after out-of-vocabulary terms have been resolved (or not). */
type ResolvedTerm = {
  /** The vocabulary term to score with. */
  term: string
  /** 1 for an exact hit; damped for a prefix or edit-distance rescue. */
  damping: number
}

/**
 * Maps query tokens onto the vocabulary, rescuing typos and truncations.
 * The vocabulary is only ~600-800 terms, so a full scan is sub-millisecond and
 * needs no index structure — and no fuzzy-search library, which would score by
 * substring similarity with no IDF and lose exactly the signal that matters.
 */
function resolveTerms(index: SupportIndex, tokens: string[]): {
  resolved: ResolvedTerm[]
  oov: string[]
} {
  const resolved: ResolvedTerm[] = []
  const oov: string[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    if (index.vocabSet.has(token)) {
      if (!seen.has(token)) { seen.add(token); resolved.push({ term: token, damping: 1 }) }
      continue
    }
    // "subscrib", "cancell", "commun", "newslet" — a member typing a stem.
    let best: { term: string; damping: number } | null = null
    if (token.length >= 4) {
      for (const term of index.vocab) {
        if (term.startsWith(token) && (!best || term.length < best.term.length)) {
          best = { term, damping: 0.6 }
        }
      }
    }
    // "cancle", "sotify", "podast".
    if (!best && token.length >= 5) {
      for (const term of index.vocab) {
        if (editDistance(token, term, 1) <= 1) { best = { term, damping: 0.5 }; break }
      }
    }
    if (best) {
      if (!seen.has(best.term)) { seen.add(best.term); resolved.push(best) }
    } else {
      // Not a no-op: an out-of-vocabulary term is the signal that the corpus
      // may simply not cover this question.
      oov.push(token)
    }
  }
  return { resolved, oov }
}

export type UnanswerableEntry = { phrases: string[]; intent: string }

/**
 * Phrases the corpus provably cannot answer, checked BEFORE ranking.
 *
 * This is the single highest-value piece of the whole design. On a corpus this
 * small the dominant failure is not "the right answer ranked second" — it is
 * confidently answering a question that has no answer here. Measured against
 * the seeded FAQs, the words refund, receipt, invoice, trial, promo, coupon,
 * gift and redeem appear ZERO times, yet members ask all of them. Left to the
 * ranker, "how do I get a refund" lands on the cancellation FAQ (wrong, and
 * expensive) and "discount code" lands on the annual-discount FAQ. Ranking
 * cannot fix that; this list can.
 */
function matchUnanswerable(
  query: string,
  entries: UnanswerableEntry[],
): string | null {
  const haystack = phraseHaystack(query)
  for (const entry of entries) {
    for (const phrase of entry.phrases) {
      const needle = phraseHaystack(phrase)
      if (needle.trim() && haystack.includes(needle)) return entry.intent
    }
  }
  return null
}

/**
 * The space-padded token string a curated phrase is matched against.
 *
 * Built from `tokenize()` rather than from raw normalised text, so the curated
 * tables share the stemmer with the ranker they are meant to override. Matching
 * the raw string instead silently loses every plural a member actually types:
 * " refund " is not a substring of " how do i get refunds ", so the guard never
 * fired and the query fell through to BM25 and the cancellation FAQ — the exact
 * outcome the list above exists to prevent. The same held for receipts,
 * invoices, trials, coupons, vouchers and gifts.
 *
 * Stopword removal makes the match more forgiving in the right direction too:
 * "charged twice" now matches "I was charged it twice", which the adjacency of
 * the raw string ruled out.
 *
 * THE COST, which is paid by the curated tables and not by this function:
 * a phrase whose only content word is common degenerates into a single-token
 * matcher that no longer means what it says. "not subscribed" became
 * " subscribe " — a term in 31 of the 32 documents — and fired its alias on
 * nearly every query in the widget, injecting `applepodcasts` into all of them.
 * Two tests in ./search.test.ts hold that line, and both tables carry a note
 * where a phrase was dropped for it. Adding a phrase here is adding a matcher
 * for its TOKENS, not for its words.
 */
function phraseHaystack(input: string): string {
  return ` ${tokenize(input).join(' ')} `
}

export type SupportAlias = {
  phrases: string[]
  /** Terms injected into the query when a phrase hits. Corpus vocabulary only. */
  expand?: string[]
  /** Terms this alias must never reach — guards known mis-bridges. */
  never?: string[]
  intent: string
  /**
   * The FAQ these phrasings actually mean, when that isn't the intent's own
   * primary answer. "can I share with my wife" belongs to the what's-included
   * topic but the answer is the family-sharing FAQ, not the plans overview.
   */
  faqKey?: string
}

/** Expands a raw query with curated bridge terms, and reports which intents fired. */
function expandQuery(query: string, aliases: SupportAlias[]): {
  /** The member's own tokens plus the expansions, for the unigram layer. */
  tokens: string[]
  /** The member's own tokens alone, for the phrase layer. */
  baseTokens: string[]
  intents: string[]
} {
  const haystack = phraseHaystack(query)
  const tokens = tokenize(query)
  const banned = new Set<string>()
  const added: string[] = []
  const intents: string[] = []

  for (const alias of aliases) {
    const hit = alias.phrases.some((phrase) => {
      const needle = phraseHaystack(phrase)
      return needle.trim().length > 0 && haystack.includes(needle)
    })
    if (!hit) continue
    intents.push(alias.intent)
    for (const n of alias.never ?? []) for (const t of tokenize(n)) banned.add(t)
    for (const e of alias.expand ?? []) added.push(...tokenize(e))
  }

  const keep = (t: string) => !banned.has(t)
  return {
    tokens: [...tokens, ...added].filter(keep),
    baseTokens: tokens.filter(keep),
    // Deduped, first-fired order preserved — two alias entries legitimately
    // share an intent (the general Apple block and the "says I'm not
    // subscribed" one both route to `apple-questions`), and when both hit, the
    // panel rendered that topic twice, as two identical buttons under "Go
    // straight to" sharing a React key. Order is load-bearing: the tables are
    // evaluated in sequence so the more specific entry can claim a query first.
    intents: [...new Set(intents)],
  }
}

export type SearchOptions = {
  limit?: number
  /** Coverage needed to auto-expand the top answer. */
  confidentCoverage?: number
  /** Coverage below which we would rather say nothing. */
  uncertainCoverage?: number
}

export function searchSupport(params: {
  index: SupportIndex
  query: string
  aliases?: SupportAlias[]
  unanswerable?: UnanswerableEntry[]
  options?: SearchOptions
}): SupportSearchResult {
  const { index, query } = params
  const aliases = params.aliases ?? []
  const unanswerable = params.unanswerable ?? []
  const limit = params.options?.limit ?? 3
  const confidentCoverage = params.options?.confidentCoverage ?? 0.55
  const uncertainCoverage = params.options?.uncertainCoverage ?? 0.25

  if (query.trim().length < 2) return { kind: 'no-match', hits: [], intents: [] }

  const knownUnknown = matchUnanswerable(query, unanswerable)
  if (knownUnknown) return { kind: 'unanswerable', hits: [], intents: [knownUnknown] }

  const { tokens, baseTokens, intents } = expandQuery(query, aliases)
  if (tokens.length === 0) return { kind: 'no-match', hits: [], intents }

  const { resolved, oov } = resolveTerms(index, tokens)
  if (resolved.length === 0) return { kind: 'no-match', hits: [], intents }

  const oovRatio = oov.length / (resolved.length + oov.length)

  const totalIdf = resolved.reduce((n, r) => n + idf(index, r.term) * r.damping, 0)
  if (totalIdf <= 0) return { kind: 'no-match', hits: [], intents }

  // Phrase layer over the member's OWN tokens, never the expanded set. Bigrams
  // taken across `[...tokens, ...added]` span the seam between what was typed
  // and what an alias injected: "cancel apple" with an alias expanding to
  // `applepodcasts` manufactures the bigram "apple applepodcasts", and two
  // aliases firing join the tail of one expansion to the head of the next. Each
  // such pair can pay out up to PHRASE_BONUS.question x idf — on a rare term,
  // comparable to SIMILAR_QUESTION_BONUS — for a phrase nobody typed. The
  // expansions still count in full as unigrams above, which is where a curated
  // bridge term belongs.
  const queryBigrams = bigrams(baseTokens)
  const normalizedQuery = normalizeText(query).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const queryTokenSet = new Set(tokens)

  const scored: (SupportHit & { idfMass: number })[] = []

  for (const doc of index.docs) {
    let score = 0
    let matchedIdf = 0

    for (const { term, damping } of resolved) {
      let tf = 0
      for (const f of FIELDS) {
        const raw = doc.fields[f].counts.get(term) ?? 0
        if (raw === 0) continue
        const len = doc.fields[f].tokens.length
        tf += FIELD_WEIGHTS[f] * raw / (1 - B + B * (len / index.avgLen[f]))
      }
      if (tf === 0) continue
      const termIdf = idf(index, term) * damping
      score += termIdf * (tf / (K1 + tf))
      matchedIdf += termIdf
    }

    // Phrase layer. This is what separates the corpus's mirror-image pairs —
    // "switch TO Apple" vs "move FROM Apple to the website" — which unigram
    // scoring cannot tell apart at all.
    for (const bg of queryBigrams) {
      const [a, b] = bg.split(' ')
      const weight = Math.max(idf(index, a), idf(index, b))
      if (weight <= 0) continue
      for (const f of FIELDS) {
        if (doc.fields[f].bigrams.has(bg)) score += PHRASE_BONUS[f] * weight
      }
    }

    if (score <= 0) continue

    const questionTokens = new Set(doc.fields.question.tokens)
    const normalizedQuestion = normalizeText(doc.faq.question)
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
    let overlap = 0
    for (const t of queryTokenSet) if (questionTokens.has(t)) overlap += 1
    const union = new Set([...queryTokenSet, ...questionTokens]).size
    const jaccard = union ? overlap / union : 0
    if (normalizedQuestion.includes(normalizedQuery)) score += CONTAINS_QUESTION_BONUS
    else if (jaccard >= EXACT_MATCH_JACCARD) score += SIMILAR_QUESTION_BONUS

    scored.push({ faq: doc.faq, score, coverage: matchedIdf / totalIdf, idfMass: matchedIdf })
  }

  if (scored.length === 0) return { kind: 'no-match', hits: [], intents }
  scored.sort((a, b) => b.score - a.score)

  const top = scored[0]
  const hits = scored.slice(0, limit).map(({ faq, score, coverage }) => ({ faq, score, coverage }))

  // Raw BM25 is not comparable across queries, so confidence is judged on IDF
  // coverage — "this answer accounts for N% of the informative words you typed"
  // — gated on having matched at least one genuinely distinctive term.
  // Both gates apply to BOTH tiers, not just the confident one: we would
  // rather show nothing and offer a topic than offer a plausible-looking FAQ
  // that answers a question nobody asked.
  if (top.idfMass < MIN_IDF_MASS) return { kind: 'no-match', hits: [], intents }
  if (oovRatio >= MAX_OOV_RATIO) return { kind: 'no-match', hits: [], intents }
  if (top.coverage >= confidentCoverage) return { kind: 'confident', hits, intents }
  if (top.coverage >= uncertainCoverage) return { kind: 'uncertain', hits, intents }
  return { kind: 'no-match', hits: [], intents }
}
