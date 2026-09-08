// Bridges between the words members type and the words the FAQ corpus uses.
//
// Every entry here exists because of a measured gap, not a guess. Counted over
// the 33 seeded FAQs, these terms appear ZERO times anywhere in the corpus:
//
//   refund · receipt · invoice · trial · password · promo · coupon · gift ·
//   redeem · unsubscribe · iphone · ios · android · circle · ads
//
// ...and members ask about every one of them. `ads` is the sharpest case: the
// corpus only ever writes the hyphenated adjective `ad-free`, so "I'm still
// hearing ads" scores literally nothing without help (the tokenizer's hyphen
// splitting covers that one; see src/lib/support/text.ts).
//
// Two tables, doing different jobs:
//   * `supportAliases` rewrites a query into corpus vocabulary and flags the
//     intent it belongs to.
//   * `supportUnanswerable` short-circuits ranking entirely for questions the
//     corpus provably cannot answer, so the widget escalates instead of
//     confidently returning a plausible-looking wrong answer.

import type { SupportAlias, UnanswerableEntry } from "../lib/support/search.js";
import type { SupportIntentId } from "./supportTopics.js";

type Alias = SupportAlias & { intent: SupportIntentId };
type Unanswerable = UnanswerableEntry & { intent: SupportIntentId };

export const supportAliases: Alias[] = [
  // --- Cancelling. `unsubscribe` is absent from the corpus and is genuinely
  //     ambiguous (emails vs membership), so the email sense is listed FIRST
  //     and more specifically; aliases are evaluated in order.
  {
    phrases: ["unsubscribe from emails", "stop the newsletter", "too many emails", "stop emailing"],
    expand: ["newsletter", "email"],
    intent: "newsletters",
  },
  {
    phrases: [
      "cancel", "unsubscribe", "stop paying", "stop billing", "stop my subscription",
      "end my subscription", "turn off auto renew", "dont renew", "do not renew",
      "quit", "opt out",
    ],
    expand: ["cancel", "cancel my subscription"],
    intent: "cancel",
  },

  // --- Prices. `pricing` occurs exactly ONCE in the corpus, inside "Pricing is
  //     kept consistent across platforms" in the Apple-cost answer — so
  //     "what's the pricing" ranks an essay about Apple's revenue share above
  //     the actual prices. Bridge it to the cost question explicitly.
  {
    phrases: ["price", "prices", "pricing", "how much", "cost", "costs", "per month", "per year", "rate"],
    expand: ["how much does it cost", "subscribe cost"],
    intent: "pricing",
  },

  // --- Sign-in. `password` appears nowhere in all 33 documents, and `locked`
  //     appears once — in the Spotify payment answer — so "locked out" lands
  //     on Spotify without this.
  {
    phrases: [
      "cant log in", "can not log in", "cannot log in", "cant sign in", "cant login",
      "locked out", "password", "forgot my password", "reset password", "reset my password",
      "wont let me in", "login not working", "no login email", "magic link",
      "doesnt recognize me", "doesnt recognise me", "no account",
    ],
    expand: ["log in", "email address", "forgot which email"],
    intent: "login-trouble",
  },

  // --- Apple, in the words members actually use.
  {
    phrases: ["iphone", "ios", "ipad", "podcasts app", "apple app", "purple app", "apple podcast app"],
    expand: ["applepodcasts"],
    intent: "apple-questions",
  },

  // --- Ads and missing episodes. The corpus dropped its dedicated
  //     "why can't I see subscriber-only episodes" answer in migration 0018,
  //     so this intent carries curated triage copy of its own.
  {
    phrases: [
      "ads", "advertisements", "commercials", "still hearing ads", "skip ads",
      "missing episodes", "cant see episodes", "episodes not showing", "no new episodes",
      "where are my episodes", "greyed out", "padlock", "locked episode",
    ],
    expand: ["subscriber episodes", "not subscribed", "adfree"],
    intent: "episodes-missing",
  },

  // --- "It says I'm not subscribed". The corpus has a FAQ for exactly this,
  //     but the Apple aliases boost every Apple document, so without binding
  //     these phrasings to the right answer it lands third.
  {
    phrases: [
      "says i am not subscribed", "says im not subscribed", "not subscribed",
      "doesnt think i am subscribed", "says i dont have a subscription",
      "wont recognise my subscription", "wont recognize my subscription",
    ],
    expand: ["applepodcasts", "not subscribed"],
    intent: "apple-questions",
    faqKey: "apple-says-not-subscribed",
  },

  // --- Annual billing. Members say "yearly" and "cheaper"; the corpus says
  //     "annual" and "discount".
  {
    phrases: ["yearly", "for a year", "per year", "a year", "cheaper", "save money", "pay upfront"],
    expand: ["annual", "discount"],
    intent: "pricing",
    faqKey: "annual-discount",
  },

  // --- The Fold. The product is called Circle by the people who use it, and
  //     "the community" by anyone who knew it under its old name — neither word
  //     appears anywhere in the corpus.
  {
    phrases: [
      "circle", "circle app", "the forum", "forum", "message board", "chat room",
      "discussion board", "ark media app", "community app", "community",
      "the community", "community access",
    ],
    expand: ["fold", "the fold"],
    intent: "community-access",
  },
  // "Is it included?" and "how do I get in?" are one topic with two answers,
  // and the topic's primary is the how-do-I-get-in one. Before the rename the
  // inclusion question outranked it on the corpus alone — its own title read
  // "Is the Community App included?". The corpus says "Fold" now, so the legacy
  // wording has nothing of its own left to match and needs the binding.
  {
    phrases: [
      "is the fold included", "is the community app included", "is the app included",
    ],
    expand: ["fold", "included"],
    intent: "community-access",
    faqKey: "community-app-included",
  },

  // --- Other podcast apps and devices.
  {
    // Deliberately unbound. Someone typing just "android" is equally well served
    // by "Can I listen in another podcast app?" and "How do I add my
    // subscription to another podcast app?" — both rank top-2 and both answer
    // them. Forcing a winner here would be tuning for a preference we don't
    // actually hold.
    phrases: ["android", "google play", "play store", "samsung", "pixel", "galaxy"],
    expand: ["another podcast app", "podcast app", "listen"],
    intent: "feed-setup",
  },
  {
    // "can I listen in my car" is the can-I-listen-elsewhere question, not the
    // how-do-I-add-it one — bind it to the answer it actually means.
    phrases: ["alexa", "echo", "sonos", "carplay", "android auto", "in my car", "smart speaker"],
    expand: ["another podcast app", "listen"],
    intent: "feed-setup",
    faqKey: "listen-other-apps",
  },
  {
    phrases: ["rss", "feed url", "private feed", "add the feed", "feed link"],
    expand: ["add my subscription", "podcast app"],
    intent: "feed-setup",
  },

  // --- Inside Call Me Back, in every name members still use for it.
  {
    phrases: ["icmb", "inside cmb", "inside call me back", "ama", "friday episode", "nadav", "amit"],
    expand: ["callmeback", "inside callmeback"],
    intent: "icmb-transition",
  },

  // --- Gifting. Zero corpus coverage; pure routing.
  {
    phrases: ["gift", "gifting", "give as a gift", "buy for someone", "present", "buy it for"],
    intent: "gift-give",
  },
  {
    phrases: ["redeem", "claim my gift", "i got a gift", "gift link", "gift code", "gift expired"],
    intent: "gift-redeem",
  },

  // --- Promo codes. `discount` appears in 5 documents, so without the `never`
  //     guard "discount code" lands on the annual-discount FAQ and tells
  //     someone holding a coupon that annual billing is cheaper.
  {
    phrases: ["promo code", "promo", "coupon", "discount code", "voucher", "redemption code"],
    never: ["discount", "annual"],
    intent: "promo-code",
  },

  // --- Newsletter delivery. The corpus answers "who receives it", not "why
  //     isn't it arriving", so this leads with the preferences page.
  {
    phrases: [
      "newsletter not arriving", "not getting emails", "no emails", "didnt receive the newsletter",
      "spam folder", "not in my inbox",
    ],
    expand: ["newsletter"],
    intent: "newsletters",
  },

  // --- Sharing. The corpus says "family members"; members say who they
  //     actually mean. Without this "can I share with my wife" drops `wife` as
  //     out-of-vocabulary and the query fails the OOV gate on the one
  //     remaining term.
  {
    phrases: [
      "wife", "husband", "spouse", "partner", "my kids", "my son", "my daughter",
      "my mum", "my mom", "my dad", "household", "second person", "share with",
    ],
    expand: ["share", "family members"],
    intent: "whats-included",
    faqKey: "family-sharing",
  },

  // --- Billing vocabulary that isn't in the corpus.
  {
    phrases: ["credit card", "debit card", "change my card", "update my card", "new card", "card expired"],
    expand: ["payment method"],
    intent: "billing",
    // Without this the phrases boost the billing topic's primary answer
    // ("How do I know where I'm subscribed?") instead of the card one.
    faqKey: "change-payment-method",
  },
  {
    phrases: ["statement", "unrecognised charge", "unrecognized charge", "what is this charge", "strange charge"],
    expand: ["where am i subscribed"],
    intent: "billing",
  },
];

/**
 * Checked BEFORE ranking; a hit skips search entirely and escalates.
 *
 * This is the highest-value list in the widget. On a 33-document corpus the
 * dominant failure mode is not a mis-ranked answer — it is a confident answer
 * to a question the corpus does not cover. It doubles as the content backlog:
 * anything here that starts getting asked a lot is an FAQ worth writing.
 */
export const supportUnanswerable: Unanswerable[] = [
  {
    phrases: ["refund", "refunded", "money back", "charged twice", "double charged", "billed twice"],
    intent: "billing-refund",
  },
  {
    phrases: ["receipt", "invoice", "for my taxes", "tax receipt", "proof of purchase"],
    intent: "billing-receipt",
  },
  {
    phrases: ["free trial", "trial period", "try it free", "try before i buy"],
    intent: "no-trial",
  },
  {
    phrases: ["student discount", "military discount", "senior discount", "group rate", "team plan"],
    intent: "billing-refund",
  },
  {
    phrases: ["delete my account", "delete my data", "close my account", "gdpr", "erase my account"],
    intent: "delete-account",
  },
  {
    phrases: ["change my email", "update my email", "new email address", "move my subscription to another email"],
    intent: "change-email",
  },
];

/**
 * Alias phrasings and topic keywords, keyed by the FAQ they should strengthen.
 * Fed into the index's `aliases` field so a curated phrase scores against the
 * right document rather than only steering the intent.
 *
 * Only the FIRST key of each topic gets the boost — its primary answer.
 * Spreading it across every related FAQ flattens the ordering WITHIN a topic,
 * which is how "where am I subscribed" ended up behind "how do I change my
 * payment method": both are billing FAQs, so both got the same boost and the
 * shorter one won. The rest of a topic's FAQs still rank on their own text.
 */
export function aliasTextByFaqKey(
  topics: { id: string; keywords: string[]; faqKeys: string[] }[],
): Map<string, string> {
  const phrasesByIntent = new Map<string, string[]>();
  for (const alias of supportAliases) {
    // Aliases that name their own FAQ are handled below; folding them into the
    // intent as well would boost the topic's primary answer with phrasings that
    // point somewhere else.
    if (alias.faqKey) continue;
    const list = phrasesByIntent.get(alias.intent) ?? [];
    list.push(...alias.phrases, ...(alias.expand ?? []));
    phrasesByIntent.set(alias.intent, list);
  }

  const byKey = new Map<string, string>();

  // An alias naming its own FAQ wins over its topic's primary answer.
  for (const alias of supportAliases) {
    if (!alias.faqKey) continue;
    const text = [...alias.phrases, ...(alias.expand ?? [])].join(" ");
    byKey.set(alias.faqKey, `${byKey.get(alias.faqKey) ?? ""} ${text}`.trim());
  }

  for (const topic of topics) {
    const primary = topic.faqKeys[0];
    if (!primary) continue;
    const text = [...topic.keywords, ...(phrasesByIntent.get(topic.id) ?? [])].join(" ");
    byKey.set(primary, `${byKey.get(primary) ?? ""} ${text}`.trim());
  }
  return byKey;
}
