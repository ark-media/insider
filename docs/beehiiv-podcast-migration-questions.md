# beehiiv — private podcast feed questions

Pre-sales / solutions-engineering questions for beehiiv, ahead of a decision to
move private RSS feeds off Supporting Cast.

Context for whoever reads this internally: we already run beehiiv for the
newsletter (`server/lib/beehiiv-sync.ts` — premium tier grants on Stripe
activation, downgrade on cancel, inbound webhook mirror). The open question is
whether the **podcast** side can carry what Supporting Cast does for us today.
As of this writing the public v2 API has no podcast resource, no podcast
webhooks, and no feed URL on the subscription object — so questions 1–3 are
genuinely blocking, not nice-to-haves.

Placeholders to fill before sending: `[N]` member count, `[PLAN]` current plan.

---

## Email draft

**Subject:** Private podcast feeds — API capability questions before we migrate

Hi —

We're Ark Media. We publish 5 podcasts and already use beehiiv for our
newsletter, including paid tiers via your v2 API. We're evaluating moving our
private/premium RSS feeds from Supporting Cast to beehiiv so members have one
account instead of two.

We've built a fair amount against Supporting Cast's API and our onboarding flow
depends on it, so before we commit I want to confirm what's possible on your
side. I've been through the v2 API reference and the podcast help articles, so
these are the gaps I couldn't close from the docs.

### Blocking — we can't migrate without answers to these

1. **Can we retrieve a subscriber's private podcast feed URL via the API?**
   Today we call Supporting Cast's `GET /users/{id}/feeds` and render each
   member's personal feed URL inside our own logged-in setup flow. I don't see a
   feed or podcast field anywhere on your subscription object, and `expand[]`
   doesn't offer one. Is there any endpoint — documented, undocumented, or
   Enterprise-only — that returns a subscriber's private feed URL? If not, what
   is the intended flow for a creator who wants members to set up the feed
   without leaving the creator's own site?

2. **Are there podcast webhooks?** Supporting Cast sends us `feed.activated`
   and `feed.access_revoked`, which is how we know a member has actually added
   the feed to their podcast app. We use that to drive a setup-progress
   indicator and to send reminder emails only to people who haven't finished
   setup. Your webhook catalog is subscription/post/newsletter-list/survey only.
   Is anything podcast-related planned?

3. **Is there a podcast analytics or download API?** We currently page through
   Supporting Cast's `GET /v1/downloads` as a second, independent activation
   signal. Your launch materials mention IAB-certified analytics — is any of
   that reachable programmatically, or is it dashboard-only?

### Important — these shape the amount of work on our side

4. **Can premium access carry an expiry date?** We sell gift subscriptions
   (6-month and 1-year). With Supporting Cast we pass `ends_at` when creating
   the subscription and it expires on its own. I don't see an expiry field on
   premium tiers, and Complimentary Access appears to be read-only in the API
   (list and show, no create). Is there a supported way to grant time-boxed
   premium access via API — or do we have to own expiry ourselves and revoke on
   a schedule?

5. **Are Complimentary Access write endpoints on the roadmap?** Read-only means
   we can't provision comped members programmatically.

6. **How granular is premium podcast gating?** We need different shows gated to
   different paid tiers — not all-or-nothing across the publication. Can each
   show be restricted to its own tier or set of tiers, and can that mapping be
   managed via API or only in the dashboard?

7. **Show limits.** We publish 5 shows. Docs list Max at 3 shows and Enterprise
   as unlimited. Can the Max limit be raised, or does 5 shows require
   Enterprise?

8. **Which plan do private feeds actually require?** Your help article says
   premium podcasts work on any plan that has an active paid tier; other
   material says private feeds are Max and Enterprise only. Which is correct?

9. **Spotify.** Supporting Cast supports Spotify Open Access — a member links
   their Spotify account once and every private show in our network unlocks
   inside Spotify. That's the single highest-conversion step in our onboarding.
   Does beehiiv support Spotify Open Access for premium feeds, or is Spotify
   public-distribution only?

### Migration mechanics

10. **Importing an existing catalog.** Is there a supported path to bring in an
    existing back catalogue (bulk import from an existing RSS feed, or per-episode
    upload via API)? Our public shows are hosted on Simplecast today.

11. **Do existing members have to re-add their feed?** Our assumption is that
    moving hosts means new private URLs and every current paying member has to
    re-subscribe in their podcast app. Is there any redirect or continuity
    mechanism, and what drop-off have other migrating creators seen?

12. **Rate limits and idempotency.** What are the practical rate limits for
    subscription writes, and does the API honour an `Idempotency-Key` header?
    We have two code paths that can race on the same Stripe subscription (a
    webhook and a post-checkout poll).

If the honest answer to 1–3 is "not today," that's genuinely useful to know —
it tells us to wait rather than half-migrate. If any of it is on the near-term
roadmap, we'd be glad to be a design partner; we've already built this
integration once and know exactly where the edges are.

Thanks,
Hannah

---

## Notes for us (do not send)

- **Q1 is the real decision point.** If there's no API for the per-member feed
  URL, `FeedSetupHub.tsx` and `SetupFlow.tsx` have no data source and we hand
  members off to a beehiiv-hosted page. That's the single biggest regression.
- **Q2 + Q3 together** determine whether `sc_feed_activations`, the setup-hub
  progress count, and `server/lib/feed-reminders.ts` survive at all. Both "no"
  means that whole feature is deleted, not ported.
- **Q4** decides whether gift expiry moves into Neon plus a revocation cron. A
  missed cron run there equals free access, so it needs real care.
- **Q10/Q11** are the hidden scope: premium gating requires beehiiv-hosted
  audio, so this is likely a Simplecast host migration too — 17 non-test files
  touch Simplecast today.
- Answers to 7 and 8 should come from sales **in writing**; the public docs
  contradict each other.
