# beehiiv — API/webhook requirements (reply to Bill)

Draft reply to Bill Curran's 2026-08-05 email. Doubles as the spec their
engineering team builds from. Everything below maps to something we call in
production today (Simplecast for public episodes, Supporting Cast for private
feeds), so nothing here is speculative.

---

## Email 1 — requirements

**Subject:** Re: beehiiv podcast API — endpoint/webhook requirements

Hi Bill,

Great news — thanks for moving on this. Your three episode endpoints are the
right shape. Below are the specific fields and parameters so your team can build
it once and we're not back with a follow-up list.

If it helps sequence things, our priority order is: private feed URL API and the
activation webhook first (that's the real blocker), then the episode endpoints
and published webhook, then tags, then the player.

**1. Episode metadata**

Context on how we use it: our site has no local episode catalog. Every show page,
episode page and the homepage rail fetches from the podcast API at request time
and caches for a few minutes. So this sits on the critical path for rendering the
site, not just a background sync.

*List episodes* — filter by show, `limit` up to 100 (we pull 50 today),
pagination so we can walk the full back catalogue, sort by published date
descending, and either a published-only filter or a status field we can filter on
ourselves (we can't leak drafts or scheduled episodes onto the public site). An
`updated_since` param would save us re-paging everything on a nightly reconcile.

*Get episode* — fields below.

*Get show* — this one wasn't on your list but we use it today. It's where our
show pages get the show description, so that copy lives in one place instead of
hardcoded in our repo. Title, description, artwork, public RSS URL, category.

*Episode fields.* Names don't matter, presence does:

- `id` — stable and immutable, it's our primary key and cache key
- `title`
- `slug` or permalink — our URLs are `/podcasts/{show}/{episode-slug}`, so it
  needs to be stable; otherwise we'll key off the id
- `published_at`, ISO 8601
- `duration` in seconds
- short/plain description — listings, meta description, OG tags
- `long_description` or show notes HTML — HTML is fine and preferred, we sanitize
  server-side against an allowlist
- episode artwork URL — we fall back to show art when it's absent
- status / is_published
- podcast id and show slug **on the episode object**, so a webhook payload is
  self-identifying
- season and episode number
- guest names, if you model them
- a direct audio URL — more on that below
- transcript URL if you have one; not required today but we'd use it

*Tags.* We'd like to tag episodes by topic and pull those into the site for topic
hubs, series collections and related episodes. Ideally free-form tags set in the
dashboard, returned on list and get, and filterable on list. Separate from the
show's iTunes category.

*Webhooks.* `episode.published` is right, plus two more:

- `episode.updated` — show notes get corrected after publish more often than
  you'd think, and we cache metadata for 5–30 minutes. Without this we either
  serve stale notes or drop the cache and hammer your API.
- `episode.deleted` / unpublished — so we can pull a page down promptly.

For all of them: an HMAC signature header with a shared secret, a unique event id
we can dedupe on, retries with backoff, per-environment endpoint config (we run
production and preview), and a way to send a test event from the dashboard.

**2. Private feeds**

Each of these maps to a Supporting Cast call we make today. The first one and the
activation webhook are what decide whether we can migrate at all.

- **Read a member's feed.** Given a subscriber id or email, return their private
  feed URL — one per show they're entitled to — plus feed name, description,
  artwork, and per-app deep links (Apple, Overcast, Pocket Casts, Spotify) if you
  generate them. We run the feed setup flow inside our own logged-in site, so we
  need this over the API. Linking out to a beehiiv-hosted setup page is a real
  conversion hit for us.
- **Grant access**, with an optional `expires_at`. We sell 6-month and 1-year
  gifts and Supporting Cast expires them on its own today. Without an expiry
  field we have to own expiry ourselves and run a revocation job, where a missed
  run means people keep free access.
- **Update access** — set an end date on cancellation so access runs to the end
  of the paid period, clear it and resume autorenew on reactivation.
- **Revoke immediately** — refunds, chargebacks, fraud.
- **Read a member's current access state.** We reconcile nightly against Stripe;
  drift between billing and access happens and we need to catch it.
- **Send a setup link by SMS or email.** Secondary if we can render the URL
  ourselves, but it converts well on mobile.
- **Bulk export** of members with feed URLs and activation state — for the
  migration itself and for ongoing reconciliation.
- **`feed.activated` webhook** — fires when a member actually adds the feed in a
  podcast app, not just when the URL is issued. It's the only signal that
  onboarding finished. We use it for a setup-progress indicator in the member's
  account and to send reminders only to people who haven't finished. Without it
  that feature goes away and "did our members successfully get the podcast"
  becomes unanswerable.
- **`feed.access_revoked` webhook**, and ideally `feed.deactivated`.

Four things on this side that are more product than API:

- **Spotify.** Supporting Cast supports Spotify Open Access — a member links
  Spotify once and every private show unlocks there. It's the highest-converting
  step in our onboarding and, honestly, the biggest single question for us. Do
  you have an equivalent, or is Spotify public distribution only?
- **Per-show tier gating.** We have 5 shows and different shows gate to different
  paid tiers, not one paywall across the publication. Can each show be restricted
  to its own tier, and can that be managed by API?
- **`Idempotency-Key` support and documented rate limits.** Two of our code paths
  (a Stripe webhook and a post-checkout poll) can race on the same member, so
  writes need to be safely retryable.
- **Back catalogue import** from an existing RSS feed — and do existing members
  have to re-add their feed after the move, or is there a redirect?

**3. Player**

Deprioritise it. It's not a blocker as long as every episode's audio has a
stable, public, hotlinkable URL from the API with range request support. We
already run our own HTML5 player on one page against direct audio URLs — 15 of
them, hardcoded, because we can't get them from an API. Getting those from you is
the actual win, and it's much cheaper for you than an embed.

Two things we'd want to understand:

- If we serve playback from our own player, how does it count toward your
  IAB-certified numbers? Is there a prefix or measurement URL we should route
  through? We don't want to migrate and lose our download numbers because we
  built our own front end.
- We'd only self-host playback for public episodes. Premium stays in the private
  feed — we wouldn't expect hotlinkable URLs for those.

If the embed does get built later, per-episode with a dark theme is what we'd use.

Happy to jump on a call if any of this is easier to talk through.

Thanks,
Hannah

---

## Notes on email 1 (do not send)

- Bill's list omitted show-level metadata (`GET /podcasts/{id}`); added it.
  `src/lib/useShowDescription.ts` and `ShowPage` depend on it today.
- The episode field list is exactly `ScEpisode` / `projectScEpisode` in
  `server/show-notes.ts`, plus audio URL and tags, which Simplecast doesn't give
  us today.
- The player answer trades an iframe for a direct audio URL. Right trade — we own
  the design and already run `<audio>` on `src/routes/israel-votes.tsx` — but it
  commits us to building a player for `ShowPage.tsx` and
  `podcasts/$show/$episode.tsx`, which embed `player.simplecast.com` today.
- Private feed asks are the same as `beehiiv-podcast-migration-questions.md`
  (Q1/Q2/Q4/Q6/Q9/Q12), restated as a build spec rather than as questions.
- **Spotify Open Access is the make-or-break answer.** Self-hosting our own
  private feed platform is off the table precisely because we can't replicate it,
  so if beehiiv can't either, we stay on Supporting Cast regardless of how good
  the rest of the API is. Everything else on the private side is buildable; this
  isn't.

---

## Email 2 — reply to Bill's response

**Subject:** Re: beehiiv podcast API — endpoint/webhook requirements

Hi Bill,

This is a good answer — thank you. Most of it we can absorb without much
trouble, so I'll take the small ones first and let the one real issue stand on
its own.

Unix timestamps are fine, we'll convert on read. No guest names and no tags we
can live with; we'll keep both in our own database keyed on your episode id.
Tags are the one I'd like to leave on the long-term list — we wanted topic hubs
and related-episode rails driven off them — but it isn't blocking. No SMS is
fine. The transactional email for feed setup is welcome, though we'll keep
sending our own reminder sequence on top of it, so the more valuable half of
that for us is the webhook telling us setup actually finished.

On revocation, you asked what action precedes `feed.access_revoked`. Our billing
lives in a Stripe account you aren't connected to, so we already know about
anything billing-driven — cancellation, expiry, refund, chargeback — and we'll
be the ones calling you to move that subscriber to free. What we can't see is
anything that happens on your side: an admin revoking or rotating a feed in the
beehiiv dashboard, or a subscriber rotating their own URL. That's the case we
need the webhook for. If it helps scope the work, that's the *only* case we're
asking you to cover — you don't need to tell us about revocations we initiated.

**Spotify — the one thing we need to solve**

I want to be straightforward about where this sits. Spotify Open Access is the
highest-converting step in our onboarding, and as things stand we can't migrate
without an equivalent. A large share of our members listen exclusively in
Spotify — they linked their account once and have never touched the RSS URL. If
that path gets worse it doesn't degrade a corner of the experience, it removes
the default one.

The good news in your reply is that the Open Access link already exists in the
beehiiv subscriber profile. So I don't think we're asking you to build Spotify
support. We're asking you not to make us send members to another site to reach
it.

Reading your note, the blocker is returning that link as a value over the API,
because it's generated inside an authenticated session. Understood. So don't
return it — **redirect to it.**

You're already building the hard part: the JWT that auto-logs a subscriber into
their beehiiv profile. If that endpoint accepted a destination —
`?destination=spotify`, or a separate endpoint that just 302s — then our flow
becomes: member clicks "Link Spotify" in their account on our site, our server
mints your JWT, we redirect, and you land them in the Open Access flow instead
of at the top of the profile page. One click for the member. We never see,
store, or handle the Spotify link, and authentication stays entirely on your
side, which I think is the actual concern. It's a parameter on an endpoint
you're already writing.

If that doesn't work, the fallback we'd accept is the Open Access link returned
from the API with a short expiry — five or ten minutes, single use. Worth saying
plainly: you're already returning the private RSS feed URL over the API, and
that URL is a credential granting audio access indefinitely. A link that expires
in ten minutes is less sensitive than something already in the spec.

Three questions attached to this, and the third may matter more than the first
two:

1. Is Open Access live in production for private feeds today, with publishers
   using it? Your note reads that way and I want to be certain I'm not reading a
   roadmap item as a shipped one. If you can put us in a sandbox with a paid test
   subscriber so we can walk the flow ourselves, that settles it faster than any
   amount of email.

2. Does one link cover multiple shows? Today a member links Spotify once and all
   five of our private shows unlock together. If your Open Access link is
   per-podcast — or per-publication, and our shows end up split across
   publications to get the tier gating we need — then a member links Spotify five
   times. That's a regression even with the redirect solved, so it's tied to the
   per-show gating question from my last note.

3. What happens to our existing Spotify listeners when we move? My assumption is
   that Open Access entitlements are registered to the platform, so every member
   who linked through Supporting Cast has to re-authorise with beehiiv. Have you
   migrated a publisher's Open Access listeners before, is there a bulk
   pre-authorisation path, and what drop-off did you see? If the honest answer is
   "everyone re-links by hand," we can plan for that — but I'd rather plan for it
   now than find out at cutover.

**Gift expiry**

On the Complimentary Gift approach, I'd rather not use it. It creates a trial in
the Stripe account connected to beehiiv while our real billing is in ours, and
two billing systems holding an opinion about the same member is a reconciliation
problem we'd be signing up for permanently.

Simpler on both sides: we grant by setting the subscriber to paid via the API,
and when a gift lapses our own scheduled job calls Update subscription by email
to put them back to free. We already run gift expiry this way. For that to be
safe I need one thing confirmed in writing — that a subscriber set to paid via
API, with no beehiiv-side billing attached, stays paid indefinitely until we
call you to change it. No lapse, no trial clock, nothing that quietly reverts.
You implied as much; I want to be sure, because if it isn't true we find out
through members losing access.

**Still open from my last note**

Flagging these only so they don't get lost, not expecting answers today:
per-show tier gating, whether 5 shows requires Enterprise, `Idempotency-Key`
support and rate limits, bulk export of members with feed URLs and activation
state, back catalogue import, and `episode.updated` / `episode.deleted` with
HMAC signing. Also confirmation that `feed.activated` is in the webhook set your
team starts on next week — that's the signal our entire setup-progress feature
runs on.

Happy to get on a call for the Spotify piece specifically. I suspect fifteen
minutes with someone from your Podcasts team resolves the redirect question
faster than another round of this.

Thanks,
Hannah

---

## Notes on email 2 (do not send)

- **Bill's reply flips the kill criterion above.** He didn't say beehiiv lacks
  Open Access — he said the SOA link lives in the beehiiv subscriber profile and
  they won't return it over the API. So "stay on Supporting Cast regardless" no
  longer applies; what's left is UX plumbing plus a migration risk, both
  survivable. Don't let the old note drive the decision.
- **The redirect ask maps to one server route on our side**: authenticated
  member → mint beehiiv JWT → 302. `FeedSetupHub.tsx:33` stops reading
  `spotifyUrl` off the feed payload and points at our own route instead.
- **Question 2 is load-bearing for the UI.** `FeedSetupHub.tsx:43` optimistically
  marks every show set up off a single Spotify click, on the comment at line 31
  that the link is network-wide. If beehiiv's is per-podcast, that optimism is
  wrong and the hero needs rethinking, not just rewiring.
- **Degraded fallback if they refuse both asks**: button → JWT auto-login →
  profile page, one extra click on the highest-converting step. Shippable as a
  temporary state only, and instrument it — `feed_spotify_linked` already carries
  `feed_count`.
- **Refusing Complimentary Gifts keeps gift expiry** in the per-axis gift system
  we already built, and avoids a second Stripe account to reconcile against.
  Trade-off is that a missed cron run means someone keeps free access.
- **Tags are now a build-ourselves item**, keyed on the beehiiv episode id.
  Topic hubs and related-episode rails depend on it.
- Bill's reply didn't touch per-show tier gating, show limits/plan (Q7/Q8 in
  `beehiiv-podcast-migration-questions.md`), idempotency, bulk export, or back
  catalogue import. The closing paragraph keeps them alive without diluting the
  Spotify ask.
