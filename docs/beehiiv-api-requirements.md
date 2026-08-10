# beehiiv — API/webhook requirements (reply to Bill)

Draft reply to Bill Curran's 2026-08-05 email. Doubles as the spec their
engineering team builds from. Everything below maps to something we call in
production today (Simplecast for public episodes, Supporting Cast for private
feeds), so nothing here is speculative.

---

## Email draft

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

## Notes for us (do not send)

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
