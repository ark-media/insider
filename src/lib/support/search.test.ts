// The help widget's retrieval gate.
//
// This suite is the acceptance criterion for the whole no-LLM approach: if the
// ranking is not good enough here, the thing to fix is the synonym table in
// src/data/supportSynonyms.ts, not the UI.
//
// It runs against the real corpus, parsed out of the migrations (see
// ./search.fixtures.ts) rather than a transcribed copy, so a future content
// migration is caught here instead of silently degrading the widget.
//
// Three groups, in ascending order of importance:
//   1. RANK_1     — the obvious phrasings land on the right answer, first.
//   2. TOP_3      — harder paraphrases at least surface it.
//   3. UNHELPFUL  — the ones that MUST NOT produce a confident answer. This is
//                   the group that matters most. On a 33-document corpus the
//                   dominant failure is not a mis-ranked answer, it is a
//                   confident answer to a question the corpus cannot address.

import { describe, expect, test } from 'bun:test'
import { buildSupportIndex, searchSupport, type SupportSearchResult } from './search'
import { loadFaqFixtures } from './search.fixtures'
import { tokenize } from './text'
import {
  aliasTextByFaqKey,
  supportAliases,
  supportUnanswerable,
} from '../../data/supportSynonyms'
import { supportTopics } from '../../data/supportTopics'

const faqs = loadFaqFixtures()
const index = buildSupportIndex(faqs, aliasTextByFaqKey(supportTopics))

const run = (query: string): SupportSearchResult =>
  searchSupport({ index, query, aliases: supportAliases, unanswerable: supportUnanswerable })

const keys = (r: SupportSearchResult) => r.hits.map((h) => h.faq.key)

/** Phrasings that should land on exactly the right answer, first. */
const RANK_1: [query: string, faqKey: string][] = [
  // Cancelling and changing
  ['how do I cancel', 'cancel-anytime'],
  ['cancel my subscription', 'cancel-anytime'],
  ['stop paying', 'cancel-anytime'],
  ['I want to stop my subscription', 'cancel-anytime'],
  ['switch to annual', 'switch-monthly-to-annual'],
  ['can I switch from monthly to annual billing', 'switch-monthly-to-annual'],
  ['can I upgrade to the bundle', 'upgrade-to-bundle'],
  ['how do I change my payment method', 'change-payment-method'],
  ['change my card', 'change-payment-method'],

  // Apple and the mirror pair the bigram layer exists for. The "community"
  // phrasings stay alongside the "fold" ones on purpose: the product was
  // renamed, the members who learned the old word were not.
  ['move from apple to the website', 'move-apple-to-website'],
  ['switch to apple and keep community', 'switch-to-apple-keep-community'],
  ['switch to apple and keep the fold', 'switch-to-apple-keep-community'],
  ['can I log into the website if I subscribed through apple', 'apple-website-login'],
  ['my iphone says I am not subscribed', 'apple-says-not-subscribed'],
  ['why does apple cost the same', 'apple-same-price'],
  ['ad free video on apple', 'apple-ad-free-video'],

  // Money
  ['whats the pricing', 'where-to-subscribe-and-cost'],
  ['how much does ark plus cost', 'where-to-subscribe-and-cost'],
  ['where can I subscribe', 'where-to-subscribe-and-cost'],
  ['is there a discount for paying yearly', 'annual-discount'],
  ['annual discount', 'annual-discount'],

  // Plans
  ['what does the bundle include', 'plan-bundle-includes'],
  ['what does a community subscription include', 'plan-community-includes'],
  ['what does a fold subscription include', 'plan-community-includes'],
  ['what does ark plus include', 'plan-ark-plus-includes'],
  ['what subscriptions do you offer', 'plans-overview'],
  ['difference between the website and apple podcasts', 'website-vs-apple'],

  // Benefits
  ['who gets the paid newsletter', 'paid-newsletter-who'],
  ['youtube', 'youtube-members-only'],
  ['members only youtube content', 'youtube-members-only'],
  ['can I share with my wife', 'family-sharing'],
  ['can my husband use it too', 'family-sharing'],
  ['is the community app included', 'community-app-included'],
  ['is the fold included', 'community-app-included'],

  // Getting started
  ['how do I add the feed to apple podcasts', 'add-feed-to-app'],
  ['can I listen in another podcast app', 'listen-other-apps'],
  ['I got a new phone', 'new-phone-setup'],
  ['do I have to set it up again on a new phone', 'new-phone-setup'],
  ['how do I access the community app', 'community-app-access'],
  ['how do I access the fold', 'community-app-access'],

  // Spotify
  ['can I pay through spotify', 'spotify-payment'],
  ['why does spotify want me to connect my account', 'spotify-connect-account'],
  ['I swear I am subscribed on overcast', 'spotify-overcast-not-showing'],

  // Account
  ['where am I subscribed', 'where-am-i-subscribed'],
  ['I cant log in', 'forgot-subscribe-email'],
  ['I forgot which email I used', 'forgot-subscribe-email'],
  ['who do I contact for support', 'contact-support'],

  // The Inside Call Me Back transition
  ['do I need to subscribe again', 'icmb-resubscribe'],
  ['what happened to inside call me back', 'icmb-what-happened'],
]

/** Harder paraphrases — surfacing the answer at all is enough. */
const TOP_3: [query: string, faqKey: string][] = [
  ['unsubscribe', 'cancel-anytime'],
  ['turn off auto renew', 'cancel-anytime'],
  ['I am still hearing ads', 'apple-says-not-subscribed'],
  ['missing episodes', 'apple-says-not-subscribed'],
  ['episodes not showing up', 'apple-says-not-subscribed'],
  ['circle', 'community-app-access'],
  ['the forum', 'community-app-access'],
  ['how much', 'where-to-subscribe-and-cost'],
  ['locked out', 'forgot-subscribe-email'],
  ['cheaper if I pay for a year', 'annual-discount'],
  ['rss feed', 'add-feed-to-app'],
  // A bare platform name is served equally well by "can I listen elsewhere"
  // and "how do I add it" — assert it surfaces the pair, not an arbitrary order.
  ['android', 'add-feed-to-app'],
  ['android', 'listen-other-apps'],
  ['listen in my car', 'listen-other-apps'],
  ['the ama', 'icmb-what-happened'],
  // Bare "icmb" is genuinely ambiguous between the two transition FAQs.
  ['icmb', 'icmb-what-happened'],
  ['what is this charge on my card', 'where-am-i-subscribed'],
]

/**
 * Queries whose ONLY acceptable outcome is "we can't answer that here".
 * A confident FAQ for any of these is a member being told something untrue.
 */
const UNANSWERABLE: [query: string, intent: string][] = [
  ['how do I get a refund', 'billing-refund'],
  ['I was charged twice', 'billing-refund'],
  ['can I get my money back', 'billing-refund'],
  ['I need a receipt', 'billing-receipt'],
  ['can you send me an invoice', 'billing-receipt'],
  ['is there a free trial', 'no-trial'],
  // NOT billing-refund. A student asking what it costs has never paid us
  // anything, and was being answered with "a refund or a charge I don't
  // recognise / we'll need to look at your account".
  ['do you have a student discount', 'concession-pricing'],
  ['is there a group rate', 'concession-pricing'],
  ['delete my account', 'delete-account'],
  ['change my email address', 'change-email'],
  // PLURALS. The curated tables are matched against tokenized text, so they
  // stem exactly as the ranker does. Matched against the raw string instead,
  // " refund " is not a substring of " how do i get refunds " and every one of
  // these fell through to BM25 — "refunds" landing on the cancellation FAQ is
  // the precise failure the unanswerable list exists to prevent.
  ['how do I get refunds', 'billing-refund'],
  ['can I get receipts for these', 'billing-receipt'],
  ['do you offer free trials', 'no-trial'],
  // Stopwords between the words of a curated phrase no longer break the match.
  ['I was charged it twice', 'billing-refund'],
]

/** Nothing in the corpus is relevant; never offer an answer anyway. */
const NO_MATCH = [
  'what is the weather',
  'asdfgh',
  'who won the football',
  'tell me a joke',
]

describe('searchSupport — ranks the obvious phrasings first', () => {
  for (const [query, faqKey] of RANK_1) {
    test(`"${query}" -> ${faqKey}`, () => {
      const result = run(query)
      expect(keys(result)[0]).toBe(faqKey)
    })
  }
})

describe('searchSupport — surfaces harder paraphrases', () => {
  for (const [query, faqKey] of TOP_3) {
    test(`"${query}" includes ${faqKey}`, () => {
      expect(keys(run(query))).toContain(faqKey)
    })
  }
})

describe('searchSupport — never answers what the corpus cannot', () => {
  for (const [query, intent] of UNANSWERABLE) {
    test(`"${query}" escalates to ${intent}`, () => {
      const result = run(query)
      expect(result.kind).toBe('unanswerable')
      expect(result.intents).toContain(intent)
      expect(result.hits).toHaveLength(0)
    })
  }

  for (const query of NO_MATCH) {
    test(`"${query}" returns nothing`, () => {
      const result = run(query)
      expect(result.kind).toBe('no-match')
      expect(result.hits).toHaveLength(0)
    })
  }

  test('a query too short to mean anything is not a search', () => {
    expect(run('a').kind).toBe('no-match')
  })
})

describe('the curated topic table stays wired to the corpus', () => {
  test('every FAQ key a topic references exists and is enabled', () => {
    const available = new Set(faqs.filter((f) => f.enabled && f.key).map((f) => f.key))
    const dangling: string[] = []
    for (const topic of supportTopics) {
      for (const key of topic.faqKeys) {
        if (!available.has(key)) dangling.push(`${topic.id} -> ${key}`)
      }
    }
    expect(dangling).toEqual([])
  })

  test('every alias that names a FAQ names a real one', () => {
    const available = new Set(faqs.map((f) => f.key))
    const dangling = supportAliases
      .filter((a) => a.faqKey && !available.has(a.faqKey))
      .map((a) => a.faqKey)
    expect(dangling).toEqual([])
  })

  test('every alias and unanswerable entry points at a known topic', () => {
    const known = new Set(supportTopics.map((t) => t.id))
    const unknown = [...supportAliases, ...supportUnanswerable]
      .map((e) => e.intent)
      .filter((id) => !known.has(id))
    expect(unknown).toEqual([])
  })

  test('escalate-only topics offer no FAQ, since none of them have one', () => {
    for (const topic of supportTopics.filter((t) => t.escalateOnly)) {
      expect(topic.faqKeys).toEqual([])
    }
  })

  // --- Curated phrases must survive the tokenizer ---------------------------
  //
  // Both curated tables are matched through `tokenize()` so they share the
  // ranker's stemmer (that is what makes "how do I get refunds" reach the
  // refund guard). The same call also drops stopwords, which means a phrase
  // whose only content word is common degenerates into a single-token matcher
  // that no longer means what it says: "not subscribed" became " subscribe ",
  // "dont renew" became " renew ", "buy it for" became " buy ". The first of
  // those fired on nearly every query in the widget and injected the alias's
  // high-IDF expansion terms into all of them.
  //
  // A phrase collapsing to one token is not wrong in itself — "my son" -> " son "
  // is exactly right. It is wrong when the surviving token is one the corpus
  // uses everywhere, or when a false positive skips ranking entirely.

  const collapsed = (phrase: string) =>
    phrase.trim().split(/\s+/).length > 1 && tokenize(phrase).length === 1

  test('no alias phrase collapses onto a term the corpus uses everywhere', () => {
    // A third of the corpus. `subscribe` sits at 32/33, which is what made
    // "not subscribed" match everything; nothing else today exceeds 5.
    const ubiquitous = index.size / 3
    const offenders = supportAliases.flatMap((alias) =>
      alias.phrases
        .filter(collapsed)
        .map((phrase) => ({ phrase, term: tokenize(phrase)[0] }))
        .filter(({ term }) => (index.df.get(term) ?? 0) > ubiquitous)
        .map(({ phrase, term }) => `${alias.intent}: "${phrase}" -> " ${term} "`),
    )
    expect(offenders).toEqual([])
  })

  test('no unanswerable phrase collapses to a single token', () => {
    // Stricter than the alias rule on purpose: a hit here skips ranking and
    // escalates, so a phrase that quietly widens to one word costs a member an
    // answer the corpus actually holds.
    const offenders = supportUnanswerable.flatMap((entry) =>
      entry.phrases
        .filter(collapsed)
        .map((phrase) => `${entry.intent}: "${phrase}" -> " ${tokenize(phrase)[0]} "`),
    )
    expect(offenders).toEqual([])
  })

  test('a renewal question is not answered with the cancellation FAQ', () => {
    // The regression that "dont renew" -> " renew " caused: `cancel` fired, and
    // the phrase bonus carried cancel-anytime to a CONFIDENT first place.
    const r = run('when does my subscription renew')
    expect(r.intents).not.toContain('cancel')
  })

  test('buying a subscription is not routed to gifting', () => {
    expect(run('I want to buy a subscription').intents).not.toContain('gift-give')
  })

  test('an intent two alias entries share is reported once', () => {
    // Both the general Apple block and the "says I'm not subscribed" one route
    // to apple-questions; undeduped, the panel drew that topic twice.
    const { intents } = run('my iphone says I am not subscribed')
    expect(intents).toContain('apple-questions')
    expect(intents.length).toBe(new Set(intents).size)
  })

  test('an ordinary subscription question does not pull in the Apple alias', () => {
    // "not subscribed" -> " subscribe " put apple-questions on almost every
    // query, and its expansion injects `applepodcasts` into the ranking.
    for (const q of [
      'can I cancel my subscription',
      'what does my subscription include',
      'is there a discount for annual subscriptions',
    ]) {
      expect(run(q).intents).not.toContain('apple-questions')
    }
  })
})
