# BI & Analytics Plan — Ark Media

**Status:** proposal, 2026-07-23
**Scope:** what to measure and how, across podcasts, Ark+ subscriptions, the Circle
community, the Beehiiv newsletter, and gifting.

---

## 1. Where we are today

An honest inventory, from the code — not aspiration.

### What's already instrumented

| Layer | Status |
|---|---|
| PostHog (browser) | `src/lib/observability.ts` — init, session replay (all text/inputs masked), `identifyUser()` with SHA-256-hashed email + `tier` person property + `posthog.group('tier', …)` |
| Typed event layer | `src/lib/analytics.ts` — `trackEvent()` over a compile-time `EventMap`. ~34 events, ~48 call sites. This is a genuinely good foundation; the plan below extends it rather than replacing it. |
| Revenue funnel | `pricing_viewed` → `plan_selected` → `checkout_opened` → `checkout_email_submitted` → `checkout_payment_submitted` → `checkout_succeeded` / `checkout_failed{stage}` |
| Churn / retention | `cancel_initiated`, `save_offer_shown/accepted/declined`, `cancellation_reason_submitted`, `subscription_cancelled`, `subscription_debundled`, `subscription_reactivated` — all tagged by flow A–E and tier |
| Gift funnel | `gift_checkout_opened/…_succeeded/…_failed`, `gift_redeemed{applied}` |
| Feed activation | `feed_app_selected`, `feed_activated{app,method}`, `feed_spotify_linked` |
| Content (thin) | `episode_play_clicked{show,episode}`, `listen_link_clicked{platform}`, `book_link_clicked`, `book_club_join_clicked` |
| Errors / perf | Sentry (`@sentry/react`), Vercel Speed Insights |
| First-party data | Neon: `membership`, `gift`, `cancellation_survey`, `sc_feed_activations`, `beehiiv_subscription`, `stripe_webhook_events` |

### The ten real gaps

1. **The funnel is dark in production.** `VITE_POSTHOG_KEY` is not set in Vercel.
   `track()` is a silent no-op without it. Everything below is theoretical until
   this is fixed — this is a launch blocker, not a nice-to-have.
2. **No server-side analytics at all.** `posthog-js` only; nothing in
   `server/`, `api/`, or `scripts/`. Client-side `checkout_succeeded` is a
   *proxy* for conversion that ad-blockers undercount and double-submits
   overcount, so the funnel has no trustworthy bottom, and nothing records
   whether webhook provisioning actually granted access.
   *(Revised 2026-07-23: this gap originally also listed renewals, dunning,
   involuntary churn and refunds. Those are not gaps — Stripe Billing reports
   them, reconciled to the ledger. See §4.2.)*
3. **Zero acquisition attribution.** `grep` for `utm_`, `gclid`, `fbclid`,
   `referral` across the whole repo returns nothing but `rel="noreferrer"`. We
   cannot answer "where did this subscriber come from" for a single member. For a
   media company whose growth is podcast mentions, newsletter swaps, and social,
   this is the single most expensive gap.
4. **Social outbound is untracked.** `src/components/SocialLinks.tsx` — five
   platforms, no `onClick`. Same for `CommunityAppLinks.tsx`,
   `community/CommunityFeed.tsx`, `community/LiveEventsStrip.tsx`.
5. **On-site listening is a click, not a listen.** `episode_play_clicked` fires
   on the Play button. The first-party player now exists (`AudioPlayer.tsx`), so
   the timeline is ours to instrument, but no start / 25% / 50% / 75% / complete
   events are emitted yet — "listening on the website" is still unmeasurable
   beyond intent-to-play.
6. **Off-platform consumption is never joined.** Downloads live in Beehiiv
   (public shows and private paid feeds alike). Not ingested. The largest
   engagement surface in the business has no representation in BI.
7. **Newsletter is a one-event product.** Only `newsletter_subscribed`. No post
   reads, no read depth, no paywall-hit on gated posts, no unsubscribe event
   (`downgradeToFree()` exists server-side and fires nothing), and no ingestion of
   Beehiiv opens/clicks.
8. **Community is a one-event product.** Only `circle_join_clicked` — the moment
   the user leaves our domain. `server/circle-community.ts` already reads Circle
   Admin v2 (events, posts, spaces) for the feed; none of it is ingested for
   analytics. We cannot measure whether Circle members are actually active.
9. **No cross-product view.** Nothing lets us ask the question that decides the
   whole strategy: *do members who use two products churn less than members who
   use one?*
10. **No warehouse.** PostHog is excellent for funnels and retention curves and
    poor at MRR truth, cohort LTV, and joining Stripe × Neon × Beehiiv × Circle ×
    the podcast host. Those need SQL over a warehouse.

---

## 2. Principles

1. **Money is measured in Stripe, not in PostHog.** Stripe Billing is the system
   of record for MRR, the churn bridge, renewals and refunds; it reconciles to
   the ledger and a product-analytics copy of it never will. Never reconcile a
   board metric against a browser event — and never rebuild one Stripe already
   reports. Emit a server event only for something Stripe (or Neon) genuinely
   cannot see; §4.2 lists the three that qualify.
2. **One chokepoint per event.** `ShowPage.play()` is the model — one function,
   one `trackEvent`, every entry point covered. Never sprinkle the same event
   across three call sites.
3. **Event names are a public contract.** Once a funnel references a name, it is
   frozen. Add a new event rather than rename. (Already documented in
   `analytics.ts` — keep enforcing it.)
4. **Extend `EventMap`, never call `posthog.capture` directly.** The type layer is
   what keeps 48 call sites from drifting.
5. **No PII in properties.** Identity goes through `identifyUser()`. Properties
   are for segmentation.
6. **`email_sha256` is the universal join key.** It already exists in
   `observability.ts`. Every third-party ingest (Beehiiv, Circle, Stripe) should
   be keyed on the same lowercase-trimmed SHA-256 so the warehouse can stitch one
   person across systems without ever storing an address.
7. **Every metric has an owner and a decision attached.** If no one would act
   differently based on the number, don't build the dashboard.

---

## 3. The metric tree

### North star

**Weekly Engaged Members (WEM)** — unique members who did at least one
value-delivering action in the last 7 days: played/downloaded an episode, opened
or read a newsletter post, or posted/commented/attended in Circle.

Why this and not MRR: MRR is the *result*. WEM is the leading indicator that
predicts it, and it's the one number that forces the three product lines to be
measured on the same footing. Report MRR alongside it, always.

### Supporting layers

**L1 — Reach (top of funnel)**
- Unique site visitors, by first-touch channel
- Podcast downloads/streams per week (Beehiiv, public + private combined)
- Social outbound clicks by platform (we send traffic *out*; measure it)
- Newsletter list size: free vs premium

**L2 — Acquisition & attribution**
- New free signups and new paid members, split by first-touch and last-touch channel
- Cost-free channel mix: organic search / direct / podcast episode / newsletter / social / referral
- Landing-page → signup conversion by entry page

**L3 — Activation** (the highest-leverage layer for a subscription business)
- Ark+: % of new members who activate a private feed within 7 days
  (`sc_feed_activations` + `feed_activated` already give us this — it's the one
  activation metric we can compute *today*)
- Circle: % who join Circle within 7 days, % who post/comment within 14
- Newsletter: % of new subs who open one of their first three sends
- **Composite:** % of new members activated on *every* axis their tier grants

**L4 — Engagement**
- WEM, plus per-product engaged members
- Listen depth on site (needs the player fix, §4.3)
- Newsletter open rate / click rate / read-through
- Circle: posts, comments, event attendance, DAU/MAU ratio
- **Breadth:** distribution of members across 1 / 2 / 3 active products

**L5 — Monetization**
- MRR, ARR, ARPU; new / expansion / contraction / churned MRR bridge
- Paid conversion rate by tier (Ark+ / Circle / Bundle) and by PWYC amount band
- Gift: purchase → redemption rate, redemption → renewal rate
- Currency mix (the per-currency work is already built; measure whether it moved
  international conversion)

**L6 — Retention & advocacy**
- Logo and revenue retention by monthly cohort
- Voluntary vs involuntary (dunning) churn — currently indistinguishable
- Save-offer acceptance by offer kind and flow (instrumented; needs a dashboard)
- Cancellation reasons (in `cancellation_survey`; never surfaced)
- **Engagement × churn:** churn rate by products-active, by listen frequency
- Referrals: members who brought another paying member; gifting as a viral loop

---

## 4. What to track — the event spec

Grouped by the gap it closes. All names follow the existing
`object_verb_past_tense` convention and go into `EventMap`.

### 4.1 Attribution (P0 — highest value per hour of work)

Not events; a capture layer. On first visit, parse `utm_*`, `gclid`, `fbclid`,
`ref`, and `document.referrer`; persist **first-touch** in `localStorage` and
**last-touch** in `sessionStorage`; register both as PostHog super-properties so
every subsequent event carries them, and as person properties on `identify()` so
they survive onto the member record.

```
first_touch_source / _medium / _campaign / _content / _referrer_host / _landing_path / _at
last_touch_source  / _medium / _campaign
```

Then tag every outbound link we control: podcast show notes, newsletter footers,
social bios, Circle posts. A `?ref=cmb-ep412` on a show-notes link is what turns
"a podcast drove 30 signups" from a guess into a number.

Also register: `entry_page`, `is_returning`, and — critically — pass
`first_touch_*` into the **Stripe Checkout session metadata** so the server-side
revenue events (§4.2) carry attribution without needing to rejoin to the browser
session.

**New events:** `outbound_link_clicked { destination, platform, placement, context }`
— one generic event behind a shared `<OutboundLink>` component, wired into
`SocialLinks`, `CommunityAppLinks`, `CommunityFeed`, `LiveEventsStrip`,
`FeedSetupHub`, and the newsletter/show-notes renderers. One chokepoint, not
seven.

### 4.2 Server-side events (P0)

Emit from `server/routes/stripe/webhook.ts` via `server/lib/analytics-server.ts`.

> **Scoped down 2026-07-23 — this section was wrong about its own premise.**
> It was written as "server-side *revenue truth*", but **Stripe Billing already
> is that.** MRR, the new/expansion/contraction/churned bridge, renewals,
> refunds, ARPU, cohort retention, dunning performance, and the
> voluntary-vs-involuntary churn split (`cancellation_details.reason`) all exist
> in Stripe, reconciled to the ledger. Re-deriving them in PostHog would produce
> a second set of numbers that disagrees with the first.
>
> Acquisition channel is in Stripe too, now that §4.1 stamps `first_touch_*`
> onto subscription metadata — revenue-by-channel is a Sigma query that
> reconciles by construction, which is a *better* answer than a PostHog chart.
>
> Nine of the eleven events originally implemented were therefore removed.
> **Three remain**, each for something Stripe genuinely cannot see. Before
> adding a fourth, check whether Stripe or Neon already answers the question.
>
> Revenue dashboards (§7) should point at Stripe, not at these events.

| Event | Source | Why it isn't in Stripe |
|---|---|---|
| `subscription_started_confirmed` | `customer.subscription.created` | Not a revenue count — the honest **numerator** for a conversion rate whose denominator (`pricing_viewed`, `checkout_opened`, drop-off by stage) exists only in the browser. Browser `checkout_succeeded` is undercounted by ad blockers and inflated by double-submits, so it can't play that role itself. |
| `member_provisioned` | after SC/Circle/Auth0 provisioning completes | Stripe cannot know whether provisioning granted access. A payment succeeds, the member gets nothing, and Stripe shows a perfectly happy customer. The delta against the row above is the silent failure rate. |
| `gift_redeemed_confirmed` | redemption handler | Redemption happens in Neon, and the magic-link path redeems server-side with **no browser event at all**. (Purchase → redemption *rate* is a query over the `gift` table; the purchase side was dropped as duplicative.) |

Each carries `tier`, `plan`, `amount_cents`, `currency`, and the `first_touch_*`
metadata forwarded from checkout — as **segmentation dimensions**, not as money.

**Two corrections made during implementation (2026-07-23):**

1. **`distinct_id` is `email_sha256`, not `auth0_sub`.** The premise above was
   wrong: `identifyUser()` did not key on `auth0_sub` — it keyed on the
   member's **plaintext email**, which also quietly contradicted the
   "PostHog never sees the address" claim in `observability.ts`. Keying the
   server on `auth0_sub` would have produced a second, disjoint PostHog person.
   Both sides now key on the lowercase-trimmed SHA-256 of the email, which
   merges the two identities *and* removes the PII. It is also already the
   universal join key for every planned third-party ingest (§2.6).
2. **Direct POST to PostHog's capture endpoint, not `posthog-node`.** The SDK
   batches in the background, and a Vercel function can be frozen the instant
   the webhook responds — dropping queued events unless every path remembers to
   await a shutdown. An awaited `fetch` is delivered before we ack Stripe, has
   no flush semantics to get wrong, matches the house convention for third-party
   HTTP (sc-client, Resend, Beehiiv), and is testable against the existing
   global-fetch mock.


### 4.3 Podcast listening (P1)

Two halves; both are needed.

**On-site.** ✅ Step 1 is done: the third-party embed was replaced with a
first-party `<audio>` element (`AudioPlayer.tsx`) fed by Beehiiv's `audio_url`.
We own the timeline, so depth events are now an instrumentation task rather than
a player rewrite — and the same player unlocks resume-position, playback speed,
and chapter UI later.
2. Keep the embed and accept click-intent only. Cheap, but "listening on the
   website" stays unanswerable.

Recommend (1), scheduled as its own project, not smuggled into the analytics work.

New events once the player is first-party:
```
episode_playback_started   { show, episode, source: 'featured'|'grid'|'archive'|'search'|'newsletter' }
episode_playback_progress  { show, episode, pct: 25|50|75 }   // fire once per threshold
episode_playback_completed { show, episode, duration_s, listened_s }
episode_playback_paused    { show, episode, at_pct }
episode_speed_changed      { rate }
```

**Off-site (the bigger number).** A nightly job pulling:
- **Beehiiv podcast stats** → downloads/streams per episode per day. Land in
  Neon (`episode_daily_stats`), not PostHog — it's aggregate, not per-person.
- **Beehiiv private feeds** → per-member feed activity. This *is* per-person and
  is the Ark+ engagement signal that currently doesn't exist.
  Note the known Spotify caveat: Open Access members stream rather than download,
  so a download-based measure undercounts them by ~3,300 — key the activation
  measure on `external_registration_type=spotify` as well.

### 4.4 Newsletter (P1)

On-site:
```
newsletter_post_viewed   { slug, post_id, gated: bool, member_tier }
newsletter_post_read     { slug, post_id, scroll_pct, dwell_s }   // fire at 70% or 45s
newsletter_paywall_hit   { slug, post_id }        // gated post, non-member — a top upgrade trigger
newsletter_upgrade_clicked { slug, from: 'paywall'|'inline' }
newsletter_prefs_changed { free: bool, premium: bool }   // src/routes/account/newsletters.tsx
newsletter_unsubscribed  { slug, source: 'account'|'email' }
```

Ingest from Beehiiv (webhook where available, nightly sync otherwise —
`server/lib/beehiiv-sync.ts` is already the right home): per-send opens, clicks,
unsubscribes, bounces, keyed on `email_sha256`. Land in Neon
`newsletter_send_stats` + `newsletter_engagement`.

`newsletter_paywall_hit` deserves special attention — it is the single most
actionable event in the newsletter product, because it identifies a specific
person wanting a specific piece of gated content.

### 4.5 Community (P1)

On-site (pre-handoff funnel):
```
community_page_viewed   { member: bool, tier }
community_feed_item_clicked { kind: 'post'|'event'|'space', space }
community_event_clicked { event_id, status: 'live'|'upcoming' }
community_space_clicked { space }
circle_join_clicked                       // exists — add { placement, tier }
```

Ingest from Circle Admin v2 (`server/circle-community.ts` already has the client
and the endpoint shapes) on a nightly job: per-member posts, comments, reactions,
event RSVPs and attendance, last-active date → Neon `circle_engagement`.

Watch out: Circle Admin v2 returns opaque space slugs and null member counts —
maintain a slug→name map, and derive space membership from member-level reads
rather than trusting the space object.

This ingest is what makes the community measurable as a *retention* product
rather than a checkbox on a pricing page. Without it, we're paying for Circle
with no evidence it works.

### 4.6 Cross-product & lifecycle (P2)

Computed nightly into Neon and pushed back to PostHog as **person properties** —
so any funnel or retention chart can be segmented by them:

```
products_active_7d       0–3
products_entitled        derived from tier
listen_frequency_30d     none | light(1–3) | regular(4–11) | heavy(12+)
newsletter_engaged_30d   bool
circle_engaged_30d       bool
activation_score         0–100, weighted across entitled axes
days_since_last_value    the churn predictor
lifecycle_stage          visitor | subscriber_free | member_new | member_activated
                         | member_engaged | member_at_risk | churned | winback
```

`days_since_last_value` crossing 21 for a paying member is the trigger for a
win-back email — an analytics investment that pays for itself in saved churn.

### 4.7 Site mechanics (P2, cheap)

```
site_search_performed { query_length, results_count, context }   // EpisodeSearch in ShowPage — has state, no tracking
page_not_found        { path, referrer }
share_clicked         { kind, id, method }
faq_expanded          { slug }
```

---

## 5. Where each number comes from

| Question | System of record | How it gets there |
|---|---|---|
| Funnels, conversion, retention curves, replay | PostHog | client `trackEvent` + `posthog-node` server events |
| MRR, ARR, churn bridge, refunds | Stripe → warehouse | Stripe data pipeline / nightly sync |
| Entitlement, tier, membership state | Neon `membership` | already the source of truth |
| Podcast downloads (public) | Beehiiv | nightly job → Neon |
| Private-feed listening (per member) | Beehiiv | nightly job → Neon |
| Newsletter sends/opens/clicks | Beehiiv | webhook + nightly sync → Neon |
| Community activity | Circle Admin v2 | nightly job → Neon |
| Transactional email delivery | Resend | webhook → Neon (bounces/complaints also feed suppression, already flagged in the launch doc) |
| Cross-system joins, cohort LTV, board metrics | **Warehouse (Neon is enough to start)** | nightly jobs above |

**Tooling recommendation:** PostHog for product analytics, session replay, feature
flags, and experimentation — it's already wired and the typed layer is built.
Add Neon as the analytics warehouse (a separate schema, `analytics.*`) rather
than standing up BigQuery/Snowflake on day one; the data volumes here are small
and the operational cost of a second warehouse isn't justified yet. Revisit if
event volume crosses ~10M/month or the nightly jobs stop fitting in a cron
window. Metabase pointed at Neon covers the SQL/dashboard need cheaply.

---

## 6. Phased roadmap

### P0 — Make what we have real (~1 week) — **implemented 2026-07-23**
1. ⬜ Set `VITE_POSTHOG_KEY` in Vercel production. **Nothing else matters until
   this ships.** *Still outstanding — needs Vercel dashboard access; this repo
   is not linked to the project. The key is present in `.env.local`, so local
   dev is live. The server half falls back to the same variable, so setting this
   one value lights up both browser and server capture.*
2. ✅ Attribution capture layer + super-properties + person properties (§4.1).
   `shared/attribution.ts` (contract), `src/lib/attribution.ts` (capture),
   registered in `observability.ts`. First-touch is write-once in localStorage;
   last-touch refreshes per session and is not overwritten by a plain direct hit.
3. ✅ Forward `first_touch_*` into Stripe Checkout metadata — subscriptions
   (`subscription_data.metadata`) and gifts (PaymentIntent metadata). Allowlisted
   and length-capped server-side; the browser is untrusted.
4. ✅ Server-side events in the Stripe webhook (§4.2) — **three**, not the nine
   originally drafted. Renewals, dunning, refunds, churn and tier changes were
   implemented, then removed: Stripe Billing already reports all of them against
   the ledger, and a second copy in PostHog would only disagree with it. What
   remains is the funnel's trustworthy bottom, whether provisioning granted
   access, and whether a gift was claimed.
5. ✅ `<OutboundLink>` chokepoint + `outbound_link_clicked` across social,
   community app links, the community feed, space suggestions, the events strip,
   the setup hub, and both content renderers. Reports the destination **host**
   only — Circle and private-feed deep links carry per-member tokens.
6. ⬜ Browser-verify the Tier 2 churn events. *Still outstanding — needs the auth
   bridge plus a member with a cancelable subscription (see
   `reference_browser_test_auth_bridge`). The P0 client work above WAS verified
   in-browser, which is how the `posthog.reset()` bug in item 2 was caught.*
7. ✅ Privacy-policy edits drafted as ready-to-paste copy in
   [`privacy-policy-edits.md`](./privacy-policy-edits.md). *Publishing is
   outstanding — the policy is a WordPress page on arkmedia.org, outside this
   repo.*

**Unlocks:** true conversion counts, first-ever channel attribution, voluntary vs
involuntary churn split, social/outbound measurement.

**Caught during implementation, worth knowing:** `posthog.reset()` clears *all*
registered super-properties, not just identity — and the auth provider calls it
on every logged-out page load. Attribution was being wiped microseconds after
capture, for exactly the population that matters most (the first-time visitor
arriving from a campaign). `resetIdentity()` now re-registers. This was invisible
to unit tests and only showed up in a real browser.

### P1 — Make the three products measurable (~3–4 weeks)
7. Newsletter events + Beehiiv ingest (§4.4).
8. Community events + Circle ingest (§4.5).
9. Beehiiv nightly ingest (§4.3, off-site half).
10. First-party audio player + playback depth events (§4.3, on-site half) —
    scope as its own project.

**Unlocks:** WEM becomes computable. Activation rates per product. The paywall-hit
upgrade trigger.

### P2 — Cross-product intelligence (~2 weeks)
11. Nightly rollup job → `analytics.*` schema in Neon.
12. Push person properties back to PostHog (§4.6).
13. Metabase on Neon; build the dashboards in §7.
14. Cohort retention and LTV by acquisition channel and by products-active.

**Unlocks:** "Bundle members churn X% less than single-product members" — the
number that justifies or kills the bundle strategy.

### P3 — Growth loops (~ongoing)
15. Referral program with tracked codes (gifting already gives us half the loop —
    `gift_redeemed` → does the recipient convert to paid?).
16. PostHog experiments on pricing page, paywall copy, activation emails.
17. Churn-risk model on `days_since_last_value` + engagement breadth, wired to
    lifecycle email.

---

## 7. Dashboards to build (and who reads them)

| Dashboard | Audience | Contents |
|---|---|---|
| **Exec weekly** | Founders | WEM, MRR bridge, new/churned members, downloads, list size — 6 numbers, one screen |
| **Acquisition** | Growth | Signups + paid conversions by first-touch channel, landing-page conversion, outbound click map |
| **Revenue funnel** | Growth | The existing Tier 1 funnel, split by tier and currency; drop-off by `checkout_failed.stage` |
| **Activation** | Product | 7-day activation by axis and tier; setup-flow funnel; feed-app mix |
| **Content** | Editorial | Per-episode downloads + on-site plays + completion rate; per-post reads; paywall hits by post |
| **Community health** | Community | DAU/MAU, posts/comments per week, event attendance, % of Circle members active |
| **Retention** | Founders / Product | Cohort curves, voluntary vs involuntary churn, save-offer performance by kind, cancellation reasons |

---

## 8. Privacy & compliance posture

**Resolved 2026-07-23: US-only company (Ark Media Podcast LLC, a Delaware LLC).
No EU/UK consent banner. PostHog fires on page load; attribution captures on
first visit as designed in §4.1. No change to the plan.**

Assessed against the live
[privacy policy](https://arkmedia.org/privacy-policy/) and
[terms of service](https://arkmedia.org/terms-of-service/), both last updated
2025-07-29. Not legal advice — the items below are the ones a privacy counsel
would flag on a first read, and three of the four are cheap doc edits.

### What the current policy covers

It's a TermsFeed-style generated policy. It discloses cookies, web beacons /
pixel tags, IP + usage data, and CCPA categories A / B / D / F. It names exactly
two vendors: **Google Analytics** and **Stripe**. Payment card data is correctly
disclaimed as never touching our servers. Children under 13 are addressed. That
baseline is adequate for the *existing* site.

### Gap 1 — Session replay is running and undisclosed (fix this one)

`observability.ts` enables PostHog `session_recording`. The policy says nothing
about session recording, replay, or heatmaps. This is the sharpest item on the
list, because session replay is the live target of a wave of US class actions
brought under the California Invasion of Privacy Act (CIPA §631/632) and its
Pennsylvania and Florida analogues, on a "wiretapping" theory.

Two facts substantially reduce our exposure and are worth preserving
deliberately: replay is configured `mask_all_text: true` + `maskAllInputs: true`,
and Stripe Elements render in a cross-origin iframe that replay cannot reach. So
we are not recording anyone's keystrokes, addresses, or card data.

**Fix:** add an explicit sentence disclosing session replay and what it masks.
Non-disclosure is the aggravating factor in these suits; disclosure is close to
free. Keep the masking defaults on — if anyone later wants to unmask a field
with `data-ph-mask="false"`, that should be a deliberate, reviewed decision.

### Gap 2 — Named vendor list is two entries out of a dozen

The policy names Google Analytics and Stripe. The stack actually processes user
data through **PostHog, Sentry, Auth0, Beehiiv, Circle, Resend, Neon, and
Vercel**. The generic "Service Providers to monitor and
analyze the use of Our Service" clause is thin cover for that.

**Fix:** name them, or at minimum name the analytics and communications
processors. This is a paragraph of work and it's the disclosure most likely to be
compared against reality.

### Gap 3 — The policy affirmatively claims we sell personal information

Verbatim: *"We may 'sell' the following categories of personal information:
Category A: Identifiers; Category B…; Category D…; Category F…"* — this is the
generator's default text, and it is very probably not true of the business.

It matters because saying it triggers obligations: under CCPA/CPRA a business
that sells or shares must post a **"Do Not Sell or Share My Personal
Information"** link and honor opt-outs. The only mechanism the policy currently
offers is emailing `hello@arkmedia.org`.

**Fix:** if we don't sell data — and nothing in this codebase does — correct the
policy to say so, and the obligation largely goes away.

**Forward-looking caveat that touches this plan:** CPRA defines *"sharing"* to
include cross-context behavioral advertising. Everything in §4.1 is first-party
and stays clear of that line. But the moment a Meta or Google Ads conversion
pixel goes on the checkout page — a natural next step once attribution shows
which channels convert — we are in "sharing" territory and the opt-out link and
GPC handling become mandatory. Worth deciding before, not after.

### Gap 4 — Do Not Track vs Global Privacy Control

The policy says *"Our Service does not respond to Do Not Track signals."*
Ignoring DNT is fine and standard. But **GPC is a different signal and is legally
binding** in California, Colorado, and Connecticut, and the policy doesn't
mention it. This only bites if we're in a sale/share posture — so fixing Gap 3
mostly resolves Gap 4 too.

### Applicability, honestly

CCPA's own thresholds are >$25M gross revenue, or PI of 100k+ California
consumers/households, or 50%+ of revenue from selling PI. Ark Media may well
clear none of them today, in which case much of the above is best practice rather
than obligation. Newer state regimes (Texas, Colorado, Virginia, Connecticut)
have lower or differently-shaped thresholds and are worth a counsel check as the
member base grows. The recommendation stands either way, because the fixes cost
a page of writing.

### One note on the hashing design

`email_sha256` is good practice and worth keeping as the universal join key
(§2.6). It should not be described internally as *anonymization* — a hashed email
is pseudonymous, still an identifier under CCPA, and still personal information.
It reduces blast radius; it doesn't take the data out of scope.

### Adjacent, outside this plan's scope but noticed

- **The ToS is scoped to one podcast.** It describes Ark Media Podcast LLC as the
  producer of *Inside Call Me Back* and covers subscriptions and recurring
  billing — but has nothing on user-generated content, community conduct, or
  moderation. Circle launches a UGC surface that the current terms don't
  contemplate.
- **No arbitration clause or class-action waiver** in a consumer subscription
  business with auto-renewing billing.
- **Auto-renewal disclosure.** The ToS states subscriptions auto-renew and fees
  are non-refundable. California's Automatic Renewal Law and the FTC's negative-
  option rule impose specific disclosure and cancellation-path requirements. The
  cancel flow is already built and instrumented (flows A–E), so this is likely a
  copy question rather than an engineering one.

These three are for counsel, not for this project — flagging them because they
surfaced while reading the same two documents.

---

## 9. Decisions

1. ~~**First-party audio player**~~ — **approved 2026-07-23.** Scoped as its own
   project in P1; unblocks all on-site listening measurement (§4.3).
2. ~~**Consent/GDPR posture**~~ — **resolved 2026-07-23.** US-only; no banner.
   See §8 for the four policy edits that should ship alongside P0.
3. **Warehouse** — Neon `analytics` schema (recommended) or a real warehouse now?
4. **Metric ownership** — who owns WEM, who owns MRR, who owns activation? A
   metric without an owner decays within a quarter.
5. **Beehiiv plan tier** — confirm webhook availability for opens/clicks; if not
   available we fall back to nightly polling, which costs a day of work.
6. **Ad pixels** — do we anticipate adding Meta/Google conversion pixels once
   attribution is live? If yes, the CPRA "sharing" obligations in §8 Gap 3 need
   settling first.
