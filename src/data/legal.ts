// Copy for the /privacy and /terms pages.
//
// PLACEHOLDER. The section skeleton below is the shape the real policies will
// take; every `body` is a description of what belongs there, not the policy
// itself. `DRAFT` drives the notice banner LegalPage renders above the content —
// flip it to `false` in the same commit that replaces the copy, and not before.
// Ark Media is supplying the final text.

export const DRAFT = true;

/** Shown as "Last updated {LAST_UPDATED}". A calendar date (YYYY-MM-DD). */
export const LAST_UPDATED = "2026-08-24";

type LegalSection = { heading: string; body: string[] };

export type LegalDoc = {
  title: string;
  lede: string;
  sections: LegalSection[];
};

export const PRIVACY: LegalDoc = {
  title: "Privacy Policy.",
  lede: "How Ark Media collects, uses, and protects your information.",
  sections: [
    {
      heading: "Information we collect",
      body: [
        "What a reader gives us directly — name and email at sign-up, the email and delivery details on a gift purchase, and anything typed into the contact form.",
        "What we receive from the services that run the membership: Stripe (payment and billing), Auth0 (sign-in), Beehiiv (newsletters), Circle (the community app), and our podcast hosting (episode delivery and private feeds).",
      ],
    },
    {
      heading: "How we use it",
      body: [
        "Delivering the membership: your private feed, newsletters, community access, and the emails that go with them.",
        "Understanding what's read and listened to in aggregate, so we can make better shows.",
      ],
    },
    {
      heading: "Analytics and cookies",
      body: [
        "Which analytics we run, what they record, and how a reader opts out.",
      ],
    },
    {
      heading: "Who we share it with",
      body: [
        "The processors named above, and the basis on which each receives it. Ark Media does not sell reader data.",
      ],
    },
    {
      heading: "Your choices",
      body: [
        "Unsubscribing from email, cancelling a membership, and requesting access to or deletion of your data.",
      ],
    },
    {
      heading: "Contact",
      body: [
        "Where to write with a privacy question, and how quickly we aim to answer.",
      ],
    },
  ],
};

export const TERMS: LegalDoc = {
  title: "Terms of Service.",
  lede: "The agreement between you and Ark Media when you use this site or hold a membership.",
  sections: [
    {
      heading: "Using this site",
      body: [
        "What visitors may and may not do with the site and its content.",
      ],
    },
    {
      heading: "Memberships and billing",
      body: [
        "Ark+, Community, and the Bundle: what each includes, that membership renews automatically until cancelled, and when each renewal is charged.",
        "Pay-what-you-choose: members set their own amount at or above the listed floor.",
      ],
    },
    {
      heading: "Cancellation and refunds",
      body: [
        "Cancelling from your account, access continuing to the end of the paid period, and the refund position.",
      ],
    },
    {
      heading: "Gifts",
      body: [
        "How a gift is claimed, how long it runs, and what happens when it ends.",
      ],
    },
    {
      heading: "Community rules",
      body: [
        "The conduct expected in the community app, and when access can be withdrawn.",
      ],
    },
    {
      heading: "Content and intellectual property",
      body: [
        "Who owns the episodes, newsletters, and site content, and what a member may do with them. Private feeds are for personal use and are not for redistribution.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: ["How we'll tell members when the terms change."],
    },
    {
      heading: "Contact",
      body: ["Where to write with a question about these terms."],
    },
  ],
};
