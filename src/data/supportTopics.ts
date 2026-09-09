// Curated topics for the help widget — the "route them to the right place"
// half, as opposed to the "find the right FAQ" half in src/lib/support/search.
//
// This table is not garnish around the search. Reading all 33 seeded FAQs,
// several of the most common support topics have NO entry in the corpus at all
// — gifting and redemption, sign-in trouble, newsletter delivery, receipts,
// promo codes. Search alone returns nothing for any of them. These topics are
// how the widget answers them anyway, by routing or by escalating.
//
// Every gate here is an ENTITLEMENT check, never a tier check — the house rule
// from src/lib/subscriberAuth.tsx. `SupportViewer` therefore has no `tier`
// field at all, so a tier check is not merely discouraged but unspellable.

import { circleUrls, type ContactTopic } from "../config/urls.js";

export type SupportIntentId =
  // Answerable from the FAQ corpus.
  | "icmb-transition"
  | "whats-included"
  | "pricing"
  | "feed-setup"
  | "episodes-missing"
  | "spotify"
  | "apple-questions"
  | "community-access"
  | "newsletters"
  | "billing"
  | "cancel"
  | "upgrade-bundle"
  | "login-trouble"
  // No FAQ exists — route or escalate.
  | "gift-give"
  | "gift-redeem"
  | "billing-refund"
  | "billing-receipt"
  | "change-email"
  | "promo-code"
  | "no-trial"
  | "concession-pricing"
  | "delete-account";

/**
 * What the widget is allowed to know about the viewer.
 *
 * Deliberately excludes `tier`. Derived once from useSubscriberAuth() by
 * viewerFrom() in src/lib/support/viewer.ts.
 */
export type SupportViewer = {
  signedIn: boolean;
  arkPlus: boolean;
  circle: boolean;
  /** Signed in holding neither axis. */
  free: boolean;
};

type SupportPredicate = (v: SupportViewer) => boolean;

export type SupportAction =
  /** In-app navigation. Closes the panel on click. */
  | { kind: "route"; label: string; to: string; search?: Record<string, string> }
  /** Off-domain. */
  | { kind: "external"; label: string; href: string; platform: string }
  /** Calls useSubscriberAuth().signIn(returnTo). */
  | { kind: "signIn"; label: string }
  /** Opens /contact with the desk preselected and the session prefilled. */
  | { kind: "contact"; label: string; topic: ContactTopic }
  /** Short curated copy. PLAIN TEXT — this file is not sanitized like DB answers. */
  | { kind: "note"; body: string };

/**
 * EVERY rule whose `when` passes contributes an action, in order — a topic
 * legitimately offers several (open the Fold, or open it in the app). A rule
 * with no `when` therefore shows to everyone, so anything that is really a
 * fallback has to say so in its predicate. Getting this wrong is not cosmetic:
 * an unguarded "Add the Fold" offered a Bundle member an upsell for the half
 * they already pay for.
 */
type SupportActionRule = { when?: SupportPredicate; action: SupportAction };

export type SupportTopic = {
  id: SupportIntentId;
  /** Chip text. Sentence case, no trailing period — the site's voice. */
  label: string;
  /** One line shown once the topic is open. */
  blurb: string;
  /** Fed to the same scorer as free text, so typing finds the topic too. */
  keywords: string[];
  /** Stable FAQ keys (faqs.key) to surface. May legitimately be empty. */
  faqKeys: string[];
  actions: SupportActionRule[];
  /** Hide the topic entirely from viewers it cannot serve. */
  visibleWhen?: SupportPredicate;
  /** Offer as a chip on the home screen, vs. reachable only by searching. */
  chip: boolean;
  /** The honest answer is "a person has to do this" — escalation renders first. */
  escalateOnly?: boolean;
};

const isGuest: SupportPredicate = (v) => !v.signedIn;
const hasArkPlus: SupportPredicate = (v) => v.arkPlus;
const hasCircle: SupportPredicate = (v) => v.circle;
const isPaid: SupportPredicate = (v) => v.arkPlus || v.circle;
/** Holds both axes — there is nothing left to sell them. */
const hasEverything: SupportPredicate = (v) => v.arkPlus && v.circle;

/**
 * The Apple fork.
 *
 * Apple Podcasts shares no customer data with us, so someone who subscribed
 * through Apple has no account here and reads as a GUEST. That is accepted
 * behaviour, not something to fix elsewhere — the widget absorbs it. Any
 * guest-state topic that would otherwise offer an /account/* link must offer
 * this instead, because src/routes/account/billing.tsx redirects guests to
 * /plus and would land a paying Apple customer on a sales page.
 */
const appleFork: SupportAction = {
  kind: "note",
  body:
    "If you subscribed through Apple Podcasts, you won't have a login here — Apple keeps those subscriptions entirely on their side, and you manage them in Apple's Settings. If you subscribed on our website, sign in and it'll all be on your account page.",
};

const contactSupport = (label = "Send us a message"): SupportAction => ({
  kind: "contact",
  label,
  topic: "support" as ContactTopic,
});

export const supportTopics: SupportTopic[] = [
  {
    id: "whats-included",
    label: "What's included, and what it costs",
    blurb: "The three subscriptions, what each one gets you, and the price.",
    keywords: ["plans", "options", "included", "membership", "subscribe", "join", "price", "cost"],
    faqKeys: [
      "plans-overview",
      "plan-ark-plus-includes",
      "plan-community-includes",
      "plan-bundle-includes",
      "where-to-subscribe-and-cost",
      "website-vs-apple",
    ],
    actions: [
      { when: isPaid, action: { kind: "route", label: "See your membership", to: "/account" } },
      {
        when: (v) => !hasEverything(v),
        action: { kind: "route", label: "Compare the plans", to: "/pricing" },
      },
    ],
    chip: true,
  },
  {
    id: "pricing",
    label: "How much it costs",
    blurb: "Prices for each subscription, monthly and annual.",
    keywords: ["price", "pricing", "cost", "how much", "monthly", "annual", "yearly", "rate"],
    faqKeys: ["where-to-subscribe-and-cost", "annual-discount", "apple-same-price"],
    actions: [{ action: { kind: "route", label: "See the prices", to: "/pricing" } }],
    chip: false,
  },
  {
    id: "feed-setup",
    label: "Set up my podcast feed",
    blurb: "Get subscriber episodes into Apple Podcasts, Spotify, or wherever you listen.",
    keywords: ["feed", "set up", "setup", "add", "rss", "listen", "podcast app", "private feed"],
    faqKeys: ["add-feed-to-app", "listen-other-apps", "apple-says-not-subscribed", "new-phone-setup"],
    actions: [
      { when: hasArkPlus, action: { kind: "route", label: "Open feed setup", to: "/setup" } },
      { when: isGuest, action: { kind: "signIn", label: "Sign in to set up your feed" } },
      {
        when: (v) => !v.arkPlus,
        action: { kind: "route", label: "See what Ark+ includes", to: "/plus" },
      },
    ],
    // Circle-only members have no podcast feed; don't offer them setup.
    visibleWhen: (v) => v.arkPlus || !v.signedIn,
    chip: true,
  },
  {
    id: "episodes-missing",
    label: "Episodes aren't showing up",
    blurb: "Subscriber episodes missing, still hearing ads, or a locked episode.",
    keywords: ["missing", "not showing", "cant see", "locked", "ads", "no new episodes", "greyed out"],
    faqKeys: [
      "apple-says-not-subscribed",
      "spotify-overcast-not-showing",
      "new-phone-setup",
      "spotify-connect-account",
    ],
    actions: [
      {
        when: hasArkPlus,
        action: {
          kind: "note",
          body:
            "Almost always one of three things: you're signed in with a different email than you subscribed with, the private feed hasn't been added to your podcast app yet, or the app hasn't refreshed. Feed setup walks through all three.",
        },
      },
      { when: hasArkPlus, action: { kind: "route", label: "Open feed setup", to: "/setup" } },
      { when: isGuest, action: appleFork },
      {
        when: (v) => !v.arkPlus,
        action: { kind: "route", label: "See what Ark+ includes", to: "/plus" },
      },
    ],
    visibleWhen: (v) => v.arkPlus || !v.signedIn,
    chip: true,
  },
  {
    id: "spotify",
    label: "Listening on Spotify",
    blurb: "Linking your Spotify account, and why it asks.",
    keywords: ["spotify", "connect", "link", "overcast", "pocket casts"],
    faqKeys: [
      "spotify-connect-account",
      "spotify-payment",
      "listen-other-apps",
      "spotify-overcast-not-showing",
    ],
    actions: [
      { when: hasArkPlus, action: { kind: "route", label: "Link Spotify", to: "/setup" } },
      {
        when: (v) => !v.arkPlus,
        action: { kind: "route", label: "See what Ark+ includes", to: "/plus" },
      },
    ],
    chip: true,
  },
  {
    id: "apple-questions",
    label: "I subscribed through Apple",
    blurb: "What's different, and where to manage an Apple subscription.",
    keywords: ["apple", "itunes", "iphone", "ios", "ipad", "apple podcasts", "app store"],
    faqKeys: [
      "website-vs-apple",
      "apple-website-login",
      "apple-says-not-subscribed",
      "apple-ad-free-video",
      "apple-same-price",
      "move-apple-to-website",
    ],
    actions: [
      {
        action: {
          kind: "external",
          label: "Manage an Apple subscription",
          href: "https://support.apple.com/en-us/118428",
          platform: "apple",
        },
      },
      { action: contactSupport() },
    ],
    chip: true,
  },
  {
    id: "community-access",
    label: "The Fold",
    blurb: "Getting in, and what's inside.",
    keywords: ["fold", "community", "circle", "app", "forum", "chat", "discussion", "members only"],
    faqKeys: ["community-app-access", "community-app-included", "plan-community-includes", "plan-bundle-includes"],
    actions: [
      { when: hasCircle, action: { kind: "route", label: "Open the Fold", to: "/fold" } },
      {
        when: hasCircle,
        action: { kind: "external", label: "Open in the app", href: circleUrls.community, platform: "circle" },
      },
      // Only to someone who holds Ark+ and NOT the Fold. Unguarded, this sold
      // the Fold to Bundle members, who already have it.
      {
        when: (v) => v.arkPlus && !v.circle,
        action: { kind: "route", label: "Add the Fold", to: "/pricing" },
      },
      {
        when: (v) => !v.circle,
        action: { kind: "route", label: "See what's inside", to: "/fold" },
      },
    ],
    chip: true,
  },
  {
    id: "newsletters",
    label: "Newsletters & emails",
    blurb: "Which newsletters you get, and how to change that.",
    keywords: ["newsletter", "email", "emails", "inbox", "spam", "unsubscribe from emails", "not arriving"],
    faqKeys: ["paid-newsletter-who"],
    actions: [
      {
        when: (v) => v.signedIn,
        action: { kind: "route", label: "Manage your newsletters", to: "/account/settings" },
      },
      { action: { kind: "route", label: "See the newsletters", to: "/newsletters" } },
    ],
    chip: true,
  },
  {
    id: "billing",
    label: "Billing & payment",
    blurb: "Where you're subscribed, and what you're paying.",
    keywords: ["billing", "payment", "card", "charge", "statement", "renew", "invoice"],
    faqKeys: ["where-am-i-subscribed", "change-payment-method", "switch-monthly-to-annual", "contact-support"],
    actions: [
      { when: isPaid, action: { kind: "route", label: "Open billing", to: "/account/billing" } },
      { when: isGuest, action: appleFork },
      { when: isGuest, action: { kind: "signIn", label: "Sign in" } },
      {
        when: (v) => !isPaid(v),
        action: { kind: "route", label: "See the plans", to: "/pricing" },
      },
    ],
    visibleWhen: (v) => v.arkPlus || v.circle || !v.signedIn,
    chip: true,
  },
  {
    id: "cancel",
    label: "Cancel or change my plan",
    blurb: "Cancel, switch billing period, or move between plans.",
    keywords: ["cancel", "stop", "end", "quit", "downgrade", "auto renew", "unsubscribe"],
    faqKeys: [
      "cancel-anytime",
      "switch-monthly-to-annual",
      "upgrade-to-bundle",
      "switch-to-apple-keep-community",
      "move-apple-to-website",
    ],
    actions: [
      { when: isPaid, action: { kind: "route", label: "Manage your membership", to: "/account/billing" } },
      { when: isGuest, action: appleFork },
      { action: contactSupport() },
    ],
    visibleWhen: (v) => v.arkPlus || v.circle || !v.signedIn,
    chip: true,
  },
  {
    id: "upgrade-bundle",
    label: "Add the other half of the Bundle",
    blurb: "You have one side — here's how to add the other.",
    keywords: ["upgrade", "bundle", "add fold", "add community", "add ark plus", "combine"],
    faqKeys: ["upgrade-to-bundle", "plan-bundle-includes", "annual-discount"],
    actions: [
      { action: { kind: "route", label: "Change your plan", to: "/account/billing" } },
      { action: { kind: "route", label: "Compare the plans", to: "/pricing" } },
    ],
    // The clean expression of "gate on entitlements": a Bundle member holds
    // both axes and never sees this; a free member holds neither and has
    // nothing to add to.
    visibleWhen: (v) => (v.arkPlus && !v.circle) || (v.circle && !v.arkPlus),
    chip: true,
  },
  {
    id: "login-trouble",
    label: "I can't log in",
    blurb: "Sign-in trouble, or you're not sure which email you used.",
    keywords: ["log in", "login", "sign in", "password", "locked out", "cant get in", "reset"],
    faqKeys: ["forgot-subscribe-email", "apple-website-login", "where-am-i-subscribed"],
    actions: [
      { action: { kind: "signIn", label: "Try signing in" } },
      { action: appleFork },
      { action: contactSupport("Email support instead") },
    ],
    visibleWhen: isGuest,
    chip: true,
  },
  {
    id: "icmb-transition",
    label: "I subscribed to Inside Call Me Back",
    blurb: "What changed when Inside Call Me Back became Ark+.",
    keywords: ["inside call me back", "icmb", "ama", "changed", "transition", "already subscribed"],
    faqKeys: ["icmb-resubscribe", "icmb-what-happened"],
    actions: [
      { when: hasArkPlus, action: { kind: "route", label: "Check your feed setup", to: "/setup" } },
      { when: isGuest, action: { kind: "signIn", label: "Sign in to check" } },
      { action: contactSupport() },
    ],
    // TODO(ark): retire this topic once the transition cohort has moved through
    // — it is only useful to people who subscribed before the Ark+ rename.
    chip: true,
  },
  {
    id: "gift-give",
    label: "Gift a subscription",
    blurb: "Buy Ark+, the Fold, or the Bundle for someone else.",
    keywords: ["gift", "gifting", "present", "buy for someone", "give"],
    // No FAQ covers gifting at all, despite /plus/gift being a shipped
    // revenue feature. Pure routing until that copy exists.
    faqKeys: [],
    actions: [{ action: { kind: "route", label: "Gift a subscription", to: "/plus/gift" } }],
    chip: true,
  },
  {
    id: "gift-redeem",
    label: "I received a gift",
    blurb: "Claim a gifted subscription.",
    keywords: ["redeem", "claim", "gift code", "gift link", "received a gift"],
    faqKeys: [],
    actions: [
      {
        action: {
          kind: "note",
          body:
            "Your gift email has a link that signs you in and sets everything up. If you can't find it, check spam — and if it's expired, send us a message and we'll reissue it.",
        },
      },
      { action: { kind: "route", label: "Claim a gift", to: "/redeem" } },
      { action: contactSupport() },
    ],
    chip: false,
  },

  // --- Escalate-only: the corpus cannot answer these, and neither can we
  //     without a person looking at the account. Never guess at them.

  {
    id: "billing-refund",
    label: "A refund or a charge I don't recognise",
    blurb: "We'll need to look at your account for this one.",
    keywords: ["refund", "money back", "charged twice", "double charged", "unrecognised charge"],
    faqKeys: [],
    actions: [{ action: contactSupport() }],
    escalateOnly: true,
    chip: false,
  },
  {
    id: "billing-receipt",
    label: "A receipt or invoice",
    blurb: "We can send one over.",
    keywords: ["receipt", "invoice", "tax", "proof of purchase"],
    faqKeys: [],
    actions: [{ action: contactSupport() }],
    escalateOnly: true,
    chip: false,
  },
  {
    id: "change-email",
    label: "Change the email on my subscription",
    blurb: "We'll move it for you.",
    // Deliberately NOT folded into forgot-subscribe-email: "which email did I
    // use" and "move me to a new email" are different jobs, and answering the
    // first when someone asked the second is confidently unhelpful.
    keywords: ["change my email", "update my email", "new email address", "different email"],
    faqKeys: [],
    actions: [{ action: contactSupport() }],
    escalateOnly: true,
    chip: false,
  },
  {
    id: "promo-code",
    label: "A promo or discount code",
    blurb: "Codes go in at checkout.",
    keywords: ["promo", "promo code", "coupon", "discount code", "voucher"],
    faqKeys: [],
    actions: [
      {
        action: {
          kind: "note",
          body: "There's a box for it on the payment step when you subscribe.",
        },
      },
      { action: { kind: "route", label: "Go to checkout", to: "/pricing" } },
      { action: contactSupport("The code isn't working") },
    ],
    chip: false,
  },
  {
    id: "no-trial",
    label: "A free trial",
    blurb: "There isn't one — but you can cancel any time.",
    keywords: ["free trial", "trial", "try it free", "try before"],
    faqKeys: ["cancel-anytime", "where-to-subscribe-and-cost"],
    actions: [
      {
        action: {
          kind: "note",
          body: "We don't run free trials, but nothing is locked in — you can cancel whenever and keep access to the end of what you've paid for.",
        },
      },
      { action: { kind: "route", label: "See the plans", to: "/pricing" } },
    ],
    chip: false,
  },
  {
    id: "concession-pricing",
    // Not a refund question, which is where these phrasings used to land: a
    // student asking what it costs was answered with "a refund or a charge I
    // don't recognise / we'll need to look at your account", having never paid
    // us anything. Pay-what-you-can is the real answer and it is a good one.
    label: "Student, group or team pricing",
    blurb: "No special rates — but you can pay what you can.",
    keywords: [
      "student discount", "military discount", "senior discount",
      "group rate", "team plan", "bulk", "site licence",
    ],
    faqKeys: ["where-to-subscribe-and-cost"],
    actions: [
      {
        action: {
          kind: "note",
          body: "We don't run separate student, military or senior rates. Instead every plan is pay-what-you-can above the floor price, so you can set it to what works for you and it stays there.",
        },
      },
      { action: { kind: "route", label: "See the plans", to: "/pricing" } },
      { action: contactSupport("Group or team subscriptions") },
    ],
    chip: false,
  },
  {
    id: "delete-account",
    label: "Delete my account or data",
    blurb: "A person handles this one.",
    keywords: ["delete my account", "delete my data", "gdpr", "erase", "close my account"],
    faqKeys: [],
    actions: [
      { action: { kind: "route", label: "Read the privacy policy", to: "/privacy" } },
      { action: contactSupport() },
    ],
    escalateOnly: true,
    chip: false,
  },
];

export const supportTopicById = new Map(supportTopics.map((t) => [t.id, t]));

/** The desk a widget escalation lands on when a topic doesn't name one. */
export const SUPPORT_ESCALATION_TOPIC: ContactTopic = "support";

/**
 * Whether this viewer may be shown this topic at all.
 *
 * Every path that surfaces a topic goes through here, not just the chip grid:
 * search reaches topics by intent as well, and gating only the chips let a
 * Bundle member search their way to "upgrade-bundle" and be sold an axis they
 * already own.
 */
export function topicVisible(topic: SupportTopic, viewer: SupportViewer): boolean {
  return topic.visibleWhen ? topic.visibleWhen(viewer) : true;
}

/** Topics offered as chips, filtered to the ones this viewer can actually use. */
export function visibleTopics(viewer: SupportViewer): SupportTopic[] {
  return supportTopics.filter((t) => t.chip && topicVisible(t, viewer));
}

/** The first action rule that applies to this viewer, for each rule in order. */
export function actionsFor(topic: SupportTopic, viewer: SupportViewer): SupportAction[] {
  const actions = topic.actions
    .filter((rule) => (rule.when ? rule.when(viewer) : true))
    .map((rule) => rule.action);

  // On an escalate-only topic the honest answer is "a person has to do this",
  // so the contact action is the primary one. Without this, `delete-account`
  // opened with "Read the privacy policy" as its first and most prominent CTA
  // — a link, offered in place of the person the topic says is required.
  // Stable partition: everything else keeps its authored order.
  if (!topic.escalateOnly) return actions;
  return [
    ...actions.filter((a) => a.kind === "contact"),
    ...actions.filter((a) => a.kind !== "contact"),
  ];
}
