# Private feed: Supporting Cast → Beehiiv (Ark Media only)

Status: plan, not started. Branch: `demo-full-site`.
Every API fact below was **verified live against our own account 2026-09-09**.

## 1. Scope

Move the paid private podcast feed off Supporting Cast onto Beehiiv private
feeds, and **consolidate all Beehiiv usage onto the Ark Media publication**.
The Call me Back publication is abandoned.

- Publication: **Ark Media** `pub_d9ee47aa-cc91-4ad0-b1e2-000191888049`
- Premium tier: **"Plus"** `tier_1ad0826a-8cb5-471a-bf13-13950f2ceab4`
- Private show: **Giraffe Sandbox | Ark+** `pod_01a05d4d-d91e-7d23-b20e-7c225707635e`
- The UI shows Beehiiv's own name and artwork — **"Giraffe Sandbox | Ark+"**, not
  ICMB. The internal slug stays `inside-call-me-back` (§3).

Out of scope: the self-hosted feed platform on `spike/private-podcast-feeds`
(migration 0017, `/f/:token/:slug.xml`, R2 audio). Beehiiv replaces the reason
that spike existed; abandon it rather than merge it.

## 2. Verified account state

| | Ark Media `pub_d9ee47aa…` **(target)** | Call me Back `pub_3a96a757…` (abandon) |
| --- | --- | --- |
| Premium tier | `tier_1ad0826a…` **"Plus"** — $8/mo, $80/yr | `tier_2505b96c…` "ArkPlus" |
| Subscribers | 2, both free | 3 (1 premium) |
| Posts | 6, all draft | 7, 2 confirmed |
| Private show | `pod_01a05d4d…` Giraffe Sandbox \| Ark+ | `pod_019fc75c…` ICMB |
| Public shows | the 5 live ones (`BEEHIIV_PODCAST_ID_*` already point here) | stale duplicates |

Both publications are pre-launch test data, so consolidation costs almost
nothing — that's what makes "Ark Media only" the cheap answer rather than a
migration project. Per [[project-greenfield-no-backcompat]] there is no
existing member base to preserve.

Note the Plus tier carries **Beehiiv-native prices ($8/$80)** which are not our
prices ($5.99/$59.99, sourced from Stripe). We bill through our own Stripe and
apply the tier over the API, so Beehiiv never charges anyone — but anyone
reading the Beehiiv dashboard will see numbers that aren't ours. Worth either
disabling those prices or accepting the discrepancy knowingly.

### The endpoints, as they actually behave

`GET …/podcasts/{show}/private_feeds/by_email/{email}` — verified returning a
live feed for a premium subscriber:

```
id       pod_feed_<uuid>          ← the TOKEN; rotates on reissue
url      https://rss.beehiiv.com/podcasts/<show-uuid>/private/<token>.xml
links    apple · castro · overcast · pocket_casts       ← the complete set
created/activated/revoked/expires  unix SECONDS, nullable except created
```

Three outcomes, all confirmed:

| Case | Result |
| --- | --- |
| premium subscriber | 200 + feed |
| **subscriber exists but is free** | **404** `Couldn't find podcasts::feedtoken …` |
| no subscriber in this publication | 404 `Couldn't find subscriber with email …` |
| podcast is not premium | 422 `SHOW_IS_PUBLIC` |

The two 404s differ only in message text. **Don't branch on the message** —
treat every 404 as "no feed yet" and let our own Neon entitlement decide
whether that's expected.

### ✅ RESOLVED 2026-09-10 — Beehiiv fixed it

Everything from "#### The controlled experiment" down is kept as history so the
same ground isn't re-walked, but the blocker is gone. Verified live 2026-09-10:

| Probe | Result |
| --- | --- |
| `by_email` / `{subId}` for both existing API-created premium subs | **200 + feed** |
| brand-new `POST /subscriptions` with `premium_tier_ids:[Plus]` | **token at t+0s** |

Both pre-existing tokens carry `created` = 1788982716 (2026-09-09 19:38 UTC) —
the same instant for two subscriptions created four hours apart, so Beehiiv
**backfilled** eligible subscribers when they deployed. The new-subscriber test
(`hannah.waxman8+mint0910@gmail.com`, `sub_f6adcbab-6ad3-454f-83e5-99499ecbf62b`)
had a token on the *first* poll, before the subscription had even left
`validating` — so mint-on-create works, which is the case that matters at
checkout. `ensureSubscribedWithPremium` now really does provision a feed.

`activated` is still `null` on a fresh token, so creation ≠ activation and the
activation mirror still keys on the `podcasts.private_feed` webhook.

**The JWT endpoint is fixed too**, and with it the Spotify flow — see §Spotify
below. Test sub left in place; delete it when convenient.

### Spotify — works today, needs nothing new from Beehiiv

`GET /v2/publications/{pub}/subscriptions/{sub}/jwt_token` now returns **200**
(was 422 "JWT token fetching not allowed"). Verified end to end from a cold,
cookie-free browser context:

1. Server-side, mint the JWT for the member's `sub_…` id (30 min, HS256,
   `access_type: write`).
2. **Decode the payload for `subscriber_id`** — a different uuid from the `sub_…`
   id (`sub_483208b6-0273-…` ↔ subscriber `0b6a3828-efa9-…`). Every
   subscriber-facing URL wants the *subscriber* uuid; the `sub_` uuid renders a
   broken page reading "You do not have access to the subscriber's data". It's in
   the JWT, so no extra API call.
3. 302 to
   `https://arkmedia.beehiiv.com/subscribe/{subscriber_uuid}/podcasts/{show_uuid}?jwt_token=…`

They land logged in on Beehiiv's **"Add to podcast app"** page for that one show:
a live **Spotify** button, Apple/Overcast/Pocket Casts/Castro, a "send yourself
an email" box prefilled with their address, and the raw private RSS URL. The
Spotify button targets Beehiiv's own
`/oauth/spotify/authorize?subscriber_id=…&redirect_path=…`, so the click
originates on Beehiiv — exactly the Open Access provenance rule they described.
Their "we must land them on the Show page" constraint is already met by this URL.

Other verified shapes on the same domain:

| | |
| --- | --- |
| subscriber profile | `/subscribe/{subscriber_uuid}/manage` |
| podcast list | `/subscribe/{subscriber_uuid}/manage?tab=podcasts` |

- **Host matters.** `arkmedia.beehiiv.com` is the **Ark Media** publication.
  `mail.ark-plus.xyz` belongs to **Call me Back** and 404s every Ark Media
  subscriber uuid — the earlier note in this plan had the wrong host.
- `/manage` exposes **"Cancel paid subscription"**, which would drop the Beehiiv
  tier while our Stripe subscription keeps billing. Always deep-link to the
  per-show page, never to `/manage`.
- Mint server-side only, for the session's own email, issue as a 302, never log
  the token.

---

## History — the investigation that led here (2026-09-09)

### ⛔ BLOCKER: nothing we can call mints a feed token


Tested end to end 2026-09-09 with `hannah.waxman8+test@gmail.com`; the earlier
assumption that granting the tier mints the token is **disproved**:

| Step | Result |
| --- | --- |
| `POST /subscriptions` with `premium_tier_ids:[Plus]` in Ark Media | 201, `tier=premium`, `["Plus"]` |
| subscription reaches `status=active` | yes, within ~10s |
| `private_feeds/by_email` polled to t+80s | **404 the whole way** |
| same test in Call me Back with the ArkPlus tier + ICMB show | **404** — not a publication or tier-binding difference |
| `POST .../private_feeds/by_email/{email}/emails` (the only write endpoint) | **404** — it *requires* a token, it does not create one |

And the one token that does work was not minted by any event we control:

```
hannah.waxman8@gmail.com   subscription created  2026-07-28
                           token created         2026-08-05   ← +8 days
ICMB show created          2026-08-03
ICMB first episode         2026-08-18
```

The token predates the first episode and postdates the show by two days, so it
was minted by neither. **No documented endpoint creates a private feed token**,
and an active premium subscriber does not get one automatically.

#### What the docs say (read 2026-09-09)

The support article **"Creating a gated premium podcast on beehiiv"**
(`/support/article/42678894045079`) states the intended mechanism:

> When a subscriber **purchases a tier that grants access to a premium podcast**,
> an automated transactional email is sent to them containing their private RSS
> URL and setup instructions.

and, as a second route:

> Subscribers can also find their private RSS URL on their **subscriber
> management page**, which includes a **Set up podcast app** option with
> platform-specific deep links and QR codes.

Setup, per the same article, is: show → **Premium podcast** section → toggle
*Premium podcast* on → **select which subscription tiers have access**. The
section only appears when the publication has at least one active paid tier.

The full podcast API surface (confirmed against `llms.txt` / the OpenAPI index —
this is the complete list, not a sample):

| | |
| --- | --- |
| `GET /podcasts`, `GET /podcasts/{show}` | read |
| `GET …/private_feeds/{subscriptionId}` | read a token |
| `GET …/private_feeds/by_email/{email}` | read a token |
| `POST …/private_feeds/{subscriptionId}/emails` | (re)send the feed email |
| `POST …/private_feeds/by_email/{email}/emails` | (re)send the feed email |
| `GET …/episodes`, `GET …/episodes/{id}` | read |

**There is no create/mint endpoint** — confirmed, not inferred. The two `…/emails`
endpoints "return 422 when the podcast is fully public **or the private feed
token is inactive**", i.e. they act on a token that already exists. Neither the
podcast nor the tier endpoints expose the show↔tier binding, so it can only be
read in the dashboard.

#### The show IS configured correctly — verified in the dashboard 2026-09-09

*Giraffe Sandbox | Ark+* → **Premium podcast** toggle **on**, **All paid
subscribers** checked, **All Plus subscribers** checked, and the UI itself counts
**"(1 subscribers)"** against that tier — i.e. Beehiiv agrees our API-created
Plus subscriber is eligible for this show. So "the tier isn't bound to the show"
is **eliminated**, and with it the batch-mint hypothesis.

Every combination has now been tried and every one 404s:

| Probe | Result |
| --- | --- |
| `GET …/private_feeds/by_email/{email}` | 404 `podcasts::feedtoken` not found |
| `GET …/private_feeds/{subscriptionId}` | 404, same error |
| `POST …/private_feeds/by_email/{email}/emails` | **404, not 422** — so there is no token record at all, not an inactive one |
| subscriber created hours earlier, `status=active`, `["Plus"]` | 404 |
| **subscriber created fresh, after the binding was confirmed**, polled to t+90s | 404 the whole way |

#### The controlled experiment that isolates it

Call me Back holds two premium `ArkPlus` subscribers on the same show
(`pod_019fc75c…` ICMB), differing only in how they were created:

| Subscriber | Created by | Feed token |
| --- | --- | --- |
| `sub_2a0db065…` `hannah.waxman8@gmail.com` | Beehiiv natively | **200** — `pod_feed_6a9f623e…`, `created` 1785938343, `activated: null` |
| `sub_aecbaee8…` `hannah.waxman8+test@gmail.com` | our `POST /subscriptions` | 404 |

Then the same address was run through the API on Ark Media —
`sub_483208b6…` `hannah.waxman8@gmail.com`, reached `status=active` within 15s,
`["Plus"]`, on a show whose Premium config we had just verified — and it **404s
to t+90s**. Same person, same email, same tier, same eligible show: the only
variable left is *how the subscription was created*.

That also kills any "it's the account / the email / eligibility" explanation, and
note `activated: null` on the working token — creation and activation are
separate, so the working one was minted without any podcast app ever fetching it.

#### What's left

**Only a Beehiiv-native purchase appears to mint the token.** The support article
says the email goes out when a subscriber *"**purchases** a tier that grants
access"*; we apply the tier over the API and deliberately never let Beehiiv sell.
That is now the only hypothesis standing, and it is a real gap for our billing
model. The one variant still untested is the self-service route — a subscriber
opening their **subscriber management page** and clicking **Set up podcast app**
— which, if it mints lazily, would explain the single working token we have
(hannah's, created 8 days after her subscription and 2 days after the ICMB show
existed) and would still be incompatible with provisioning at checkout.

**Do this next:**

1. Open the subscriber management page for `hannah.waxman8+test@gmail.com` (the
   "manage your subscription" magic link Beehiiv emails) and click **Set up
   podcast app**, then re-run `private_feeds/by_email`. This is the last thing we
   can test ourselves.
2. Ask Beehiiv, with the ambiguity now removed: *the show is premium, the Plus
   tier is checked on it, and the subscriber is `active` on Plus — but the tier
   was applied via `POST /subscriptions` with `premium_tier_ids` rather than a
   Beehiiv checkout, because billing runs through our own Stripe. No private feed
   token is ever created (all three private-feed endpoints 404, including the
   send-email one, which would 422 if a token existed but were inactive). **What
   mints the token for an API-granted premium subscriber?** Is there an endpoint,
   or does it require a Beehiiv-native purchase?*

Note for whenever this unblocks: `POST /subscriptions` returns the new subscriber
in status **`validating`**, not `active` (it settles within seconds). Our mirror
stores whatever comes back, and `isReceivingEmails` accepts only `active`/`pending`,
so a row written at that instant reads as "not subscribed" until the next refresh.

Once a token does exist, `POST …/private_feeds/by_email/{email}/emails` is
Beehiiv's own "here is your feed" transactional email, which replaces our
`routes/sms.ts` setup-link machinery rather than needing a new one (§5 Phase 5).

422 is a config alarm, not a member state — log it loudly.

### Premium episodes are readable

The Giraffe show returns its published episode to our publisher key with a
plain `audio_url` on **`podcasts.beehiiv.com`** — the same host as the public
shows, already in `vercel.json`'s CSP `media-src`. So `/plus/inside-call-me-back`
gets in-browser playback for members with **no CSP change and no new code**,
through the existing `resolveAudioAccess` gate in `server/routes/podcasts.ts`.

That also confirms the audio URL is unauthenticated, exactly as the existing
comment in that file assumes: our gate is the only thing protecting it.

### JWT auto-login — the Spotify path, currently blocked

```
GET /v2/publications/{pub}/subscriptions/{sub}/jwt_token → { data: { jwt_token } }
→ https://mail.ark-plus.xyz/subscribe/{sub_id}/podcasts/{show_id}?jwt_token={jwt}
```

Lands the member signed-in on Beehiiv's own show page, which is where the
Spotify link must be clicked (Spotify Open Access verifies the traffic
originates from Beehiiv). This is the only route to one-click Spotify —
`protocol_links` will never carry it.

> **Blocked.** Returns **`422 {"message":"JWT token fetching not allowed"}`** on
> **both** publications, using the same key that reads private feeds fine. Go
> back to Beehiiv with: which publication was enabled, and does it need a
> different key or an OAuth scope? Also confirm **which publication
> `mail.ark-plus.xyz` belongs to** — it must be Ark Media after consolidation,
> and the API doesn't expose publication URLs.

It mints a **login**, so when it unblocks: server-side only, for the
authenticated session's own email, never a client-supplied subscription id;
issue as a **302** from our own route so the token stays out of HTML and logs;
soft-fail to the copy-paste URL rather than an error page.

## 3. Show identity comes from Beehiiv

The UI shows the Beehiiv show as Beehiiv names it. That removes what was
otherwise the fiddliest part of this migration: Beehiiv's `show.title` and
`artwork_url` flow into the RSS feed itself, so the member's podcast app was
always going to say "Giraffe Sandbox | Ark+" no matter what our site claimed.
Matching it means nothing to reconcile, and no Beehiiv-side rename to do.

Make that structural rather than a second hardcoded name — **read title and
artwork from the API**, so when the sandbox is replaced by the real ICMB show,
the site follows on a config change with no deploy:

- Extend `/api/podcasts/show` (`server/routes/podcasts.ts`) to return `title`
  and `artworkUrl` alongside the `description` it already serves.
- `ShowPage` already does exactly this for copy —
  `useShowDescription(show.slug) || show.tagline`. Extend that hook and apply
  the same fallback shape to title and cover.
- `FeedSetupHub` / `SetupFlow` render `feed.name` and `feed.image_url` today
  (SC's fields). Point them at the private-feed response's `show.title` /
  `show.artwork_url`, which is the same data on a call we're already making.

**Keep the slug `inside-call-me-back`.** It's an identifier, not copy, and
renaming it touches the `ShowSlug` union, the `ShowRoute` type, the route file,
`routeTree.gen.ts`, `showListenLinks`, `BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK`,
and **`src/data/hosts.ts` in four places** — all of it to be undone when the real
ICMB show lands. A slug that doesn't match a display name is normal and costs
nothing; the URL `/plus/inside-call-me-back` is a low-visibility surface
pre-launch. (Say so if you'd rather the URL match, and it's a contained rename.)

Two consequences worth knowing:

- `hosts.ts` binds Dan Senor and three others to `inside-call-me-back`, so the
  sandbox show will display them as hosts. Harmless pre-launch and correct again
  when ICMB arrives — leaving it is the low-churn call.
- The show's Beehiiv description is *"This is the premium version of Giraffe
  Sandbox. Listen ad-free, early, and get exclusive bonus content"*, and its
  author is "Ark Media". Once the description is read from the API, that string
  is what the show page shows.

## 4. What changes vs Supporting Cast

| | Supporting Cast | Beehiiv |
| --- | --- | --- |
| Join key | `membership.sc_user_id` (int) | member email |
| Provisioning | `POST /subscriptions` w/ price id | apply the Plus tier — **already done** |
| Feed identity | numeric, stable | `pod_feed_<uuid>` token, **rotates** |
| Feeds per member | N + network Spotify | 1 |
| Deep links | apple_podcasts, spotify, youtube_music, overcast, pocket_casts | apple, castro, overcast, pocket_casts (+ Spotify via JWT) |
| Activation | `feed.activated` webhook only | webhook **and** readable `activated` |
| Gift expiry | SC `ends_at`, upstream | ours to enforce |
| Roster read | `GET /v1/memberships` | none — use Neon |

The headline simplification was going to be that **feed provisioning
disappears** — Beehiiv gates the feed on the premium tier we already push, so
`provisionSc`,
`SC_SUBSCRIPTION_PRICE_ID_*`, `findOrCreateScUser`, `AlreadySubscribedError`
and the three-layer SC dedup all go away.

That still holds for everything *except* minting the feed itself, which §2 shows
we have no way to trigger. The deletions are safe; the replacement is not yet
complete.

### Billing: our Stripe grants, Beehiiv never sells

All payment and subscription runs through **our own Stripe account**. Beehiiv's
"Plus" tier is a **grant we apply over the API** on successful checkout — never
a product Beehiiv sells. Three consequences:

**1. Disable the Beehiiv-native prices on the Plus tier.** `price_0d288e71…`
($8/mo) and `price_02551787…` ($80/yr) are both `enabled: true` today. Leave
them and Beehiiv's own subscribe page can sell a competing subscription we know
nothing about — and the failure mode is nasty, not merely untidy: that buyer
gets premium, gets the feed, has no Neon membership row, and the nightly
reconciler (which downgrades anyone outside Neon's arkPlus keep-set) **revokes
their feed while they keep paying Beehiiv**. Disabling the prices is the fix;
the alternative is teaching the reconciler to tolerate Beehiiv-native premium,
which reopens the two-sources-of-truth problem this whole design avoids.

**2. The grant path has never actually run.** `BEEHIIV_PREMIUM_TIER_ID` is blank
in **both `.env` and `.env.local`**, and `ensureSubscribedWithPremium` returns
early when it is unset. So every call to date has been a silent no-op, and the
same gap makes `/account/newsletters`' premium toggle throw
`PremiumNotConfiguredError` → 503. This is unproven code about to become the
single most load-bearing call in the product. Treat its first real execution as
a test, not a deploy. (Check Vercel too — the blank may be local-only.)

**3. Grant coverage is good but not total.** `ensureSubscribedWithPremium` is
called from `activation.ts` (first activation + axis-added) and
`routes/gift.ts` (redemption), so both purchase doors are covered. But the only
writers of a `membership` row are the Stripe webhook and gift redemption — a
comped or staff member added by hand-written SQL gets `arkPlus` in Neon and **no
Beehiiv tier, therefore no feed**, with nothing to surface it. Either add an
admin grant action or give the reconciler a grant pass alongside its downgrade
pass. (This was equally true under SC; it is simply more visible now the feed
*is* the product.)

## 5. Consolidation onto Ark Media

Before any feature work, the publication move (mostly ops, little code):

1. Repoint env — `BEEHIIV_PUBLICATION_ID_ARK_DAILY` and
   `..._MEMBERS_LETTER` → `pub_d9ee47aa…`. `..._PODCASTS` already points there.
   All three now resolve to one publication, so `publicationIdFromEnv()`
   (beehiiv-sync.ts) and `resolvePublicationId()` (podcasts.ts) return the same
   id. Per greenfield posture, **collapse them to a single
   `BEEHIIV_PUBLICATION_ID`** and delete the `||` fallback chains rather than
   leave three names for one thing.
2. `BEEHIIV_PREMIUM_TIER_ID=tier_1ad0826a-8cb5-471a-bf13-13950f2ceab4` — it is
   **blank today**, so nothing is applying a tier at all right now.
3. `BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK=pod_01a05d4d-…` — the existing
   `BEEHIIV_PODCAST_ID_<SLUG>` convention resolves it with no code change.
4. Re-create in Ark Media: the two confirmed newsletter posts, the newsletter
   itself (free + premium audiences), and the 3 Call me Back subscribers.
   Trivial at this size; do it by hand.
5. Move the sending domain `mail.ark-plus.xyz` to Ark Media (needed for both
   newsletter delivery and the JWT redirect target).
6. Re-register the webhook against Ark Media:
   `https://<APP_BASE_URL>/api/beehiiv/webhook?key=$BEEHIIV_WEBHOOK_SECRET`,
   subscribing to `subscription.*` **and** `podcasts.private_feed.*`.
7. Provision the `First Name` / `Last Name` custom fields on Ark Media
   (`scripts/beehiiv-provision-custom-fields.ts`) — `syncSubscriberName`
   silently discards values when the field definition doesn't exist.

Nothing in `BEEHIIV_PODCAST_ID_*` for the 5 public shows changes; they already
point at Ark Media shows.

**Verification gate for the whole plan** (~5 min, manual). Prove the grant
*and* the revoke, since both halves are now ours to drive:

1. Apply the Plus tier to a test subscriber in Ark Media → re-run
   `private_feeds/by_email`. A 200 with a feed URL proves provisioning,
   entitlement and feed issuance in one shot.
2. Remove the tier from the same subscriber → the feed should 404 again and a
   `podcasts.private_feed.access_revoked` webhook should fire. That is the exact
   path a cancellation takes (`downgradeToFree`), and it is the half nothing
   else tests.

**Run 2026-09-09 against `hannah.waxman8+test@gmail.com`. Step 1 failed** — see
the blocker in §2. Step 2 (revoke) could not be attempted, because there was
never a token to revoke. Two test subscribers were left in place for re-testing
once Beehiiv answers: `sub_c9679e13…` (Ark Media, Plus) and `sub_aecbaee8…`
(Call me Back, ArkPlus — created only as an A/B control, safe to delete).

## 6. Phased plan

> **STATUS 2026-09-10: all phases implemented, uncommitted.** Typecheck, `knip`
> and 1333 tests green; migration 0023 applied to the live DB; verified in the
> browser end to end (see §10).



### Phase 1 — server: feed resolution

New `server/lib/beehiiv-feeds.ts`:

- `fetchPrivateFeed(env, email, podcastId)` → `{ id, url, protocolLinks,
  activatedAt, revokedAt, expiresAt, show: { title, artworkUrl } }` or `null`.
  The show fields feed the setup UI directly (§3).
- **404 → null** (both variants). **422 → log loudly, return null.**
- `fetchWithTimeout`; unix seconds → ISO via `toIsoDate` (`server/lib/dates.ts`).
- Short in-process TTL cache keyed `pubId:podcastId:email` (~60s) — `/api/me`
  runs on every page load and this is a per-member upstream call. Measured
  **290–390ms warm, ~950ms cold** (5 runs), so a cache miss adds a third of a
  second to `/api/me` — nothing like the 7–16s the episode list costs, and the
  reason this design is viable at all.

`server/routes/me.ts`: replace the SC block (today
`createScClient(env).call('GET', /users/${scUserId}/feeds)` keyed on
`resolved.scUserId`) with one `fetchPrivateFeed` keyed on `identity.email`,
still gated on `entitlements.arkPlus`, still soft-failing to `[]`. Keep the
field named `feeds` (array of one) so the client shape survives.

### Phase 2 — activation mirror

**Key on the show id, not the feed token** — the token rotates on reissue and
would silently reset a member's "set up" state.

Migration `0022_beehiiv_feed_activations.sql`:

- `beehiiv_feed_activations (email, show_id text, activated bool, activated_at,
  revoked_at, pending_at, updated_at, primary key (email, show_id))`
- `beehiiv_webhook_events (id text primary key, type text, received_at)`
- **Drop** `sc_feed_activations` and `sc_webhook_events` — no history worth
  migrating pre-launch.
- Add **`membership.created_at`** — the reminder cron needs a join date once
  the SC roster is gone (Phase 5).

`server/lib/feed-activations.ts`: port to the new table; `feedId: number` →
`showId: string` across `recordFeedActivated`, `recordFeedRevoked`,
`recordFeedsPending`, `getSetupStates`, `getActivatedFeeds`,
`getActivatedEmails`.

Webhook: **extend the existing `/api/beehiiv/webhook`** — one secret, one
registration. Dispatch on `event_type` **before** the `isKnownReader` check,
which reads `data.email`; podcast events carry **`data.subscription.email`** and
**`data.show.id`**. Map activated → `recordFeedActivated`, access_revoked /
deactivated → `recordFeedRevoked`. Dedupe on `uid`, keeping the
read-then-write-after-success ordering `sc-webhook.ts` already gets right. Then
delete `server/routes/sc-webhook.ts` and `SC_WEBHOOK_SECRET`.

Belt and braces: fold the live `activated` from the GET into `/api/me`, so a
missed webhook can't strand the progress display.

### Phase 3 — front end

`src/lib/auth.ts`: `UserFeed.id: number` → `string`; add `protocolLinks`. Keep
`name`/`image_url` — they now carry Beehiiv's show title and artwork (§3). Ripples
to `markFeedsSetUp` (`subscriberAuth.tsx`), `sendSetupSms(feedId)`, and the
`?feed=` param in `PodcastFeedSetup.tsx` / `account/podcast-feed.tsx` (parses to
a number today). `/api/me/feeds/setup` body validation demands positive integers
— becomes a string check.

`SetupFlow.tsx` `APPS`:

- `apple`: `scApp: 'apple_podcasts'` → `'apple'`
- `overcast`, `pocketcasts`: keys already match
- **add** Castro
- **Spotify**: keep the tile, repoint at `GET /api/me/feeds/spotify` (mint JWT →
  302). Gate on the JWT endpoint being enabled; until then fall back to
  copy-paste.
- **remove** YouTube Music — no protocol link and the Beehiiv page doesn't
  cover it
- `downcast`, `manual`: unchanged

`FeedSetupHub.tsx` — with one feed, `ProgressMeter` ("3 of 6 shows set up") and
"every show in the network" are both meaningless, and the Spotify hero changes
mechanism. Recommendation: keep the hub behind `feeds.length > 1` so it returns
free when a second private show lands, and have `PodcastFeedSetup` render
`SetupFlow` directly at n=1.

`src/data/shows.ts`: **uncomment the `inside-call-me-back` entry** — it is
commented out today, so `/plus/inside-call-me-back` renders "Show not found".
Set `title` / `shortTitle` to the Beehiiv name as the *fallback* (the live value
comes from the API, §3); slug and route unchanged;
`showListenLinks["inside-call-me-back"]` stays `[]`. With
`BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK` set, the show page also gets real
episodes and in-browser playback through the existing gate (§2).

### Phase 4 — provisioning and entitlement

> **Status 2026-09-09: the activation.ts half of this phase is DONE** (subscription
> path only). The Beehiiv premium grant replaced `provisionSc`; the marker is
> `beehiiv_premium`; `ensureSubscribedWithPremium` returns a boolean, throws on
> failure and on a missing tier id, and runs as the provisioning step rather than
> inside the welcome branch. `AlreadySubscribedError`, `revokeScFeed` and
> `syncScCancelSchedule` are deleted. `BEEHIIV_PREMIUM_TIER_ID` is set and the
> grant is proven against the live API. **Not done in this phase:** the gift half
> of `activateGiftForRecipient` (still SC), the `reconcileScAxis` inversion below,
> and dropping resolver fallback 2b.

`server/lib/activation.ts`:

- Delete `provisionSc`, `resolveScPriceId`, `resolveScGiftPriceId`,
  `AlreadySubscribedError`, and the SC half of `activateGiftForRecipient`.
- **Promote the Beehiiv premium push out of the welcome branch.** Today
  `ensureSubscribedWithPremium` runs inside `if (wasUnprovisioned)` wrapped in
  `tryPush` — best-effort, fine when SC was the feed. It is now *the feed
  provisioning* — **necessary but, per §2's blocker, not yet sufficient**: the
  tier alone does not mint a token, so this step needs whatever Beehiiv tells us
  the missing trigger is. It must run on every
  activation pass, be stamped on the sub (`beehiiv_premium: 'true'`) the way
  `sc_subscription_id` is today, and drive `addingArkPlus` and the axis-added
  email off that stamp so a webhook retry completes it.
- The existing ordering comment ("SC first, so a later Auth0/Circle outage
  can't block feed access") still holds — Beehiiv premium takes SC's slot.
- Gifts: no upstream `ends_at`. `arkPlusEndsAt` still lands on the membership
  row; enforcement moves to the reconciler.

`server/entitlement.ts`: `reconcileScAxis` is replaced, not ported.

1. It drives the Beehiiv downgrade off the **SC roster** today. With no roster,
   the scan inverts: walk Neon membership rows whose `liveAxes(row).arkPlus` is
   false and call `downgradeToFree`. Keep the mass-wipe fail-safes in spirit
   (per-run cap, skip on an empty or incomplete keep-set).
2. **This becomes the only thing that expires a gifted feed.** Its own test:
   past `ark_plus_gift_expires_at`, no subscription → Beehiiv downgrade.

`server/lib/entitlement-resolver.ts`: drop fallback **2b** (SC-by-email grants
arkPlus); keep 2a (Stripe-by-email true-tier), a Neon read covering the same
webhook-lag window. `membership.sc_user_id` and `ResolvedMembership.scUserId`
become dead — drop both.

### Phase 5 — reminders, Spotify redirect, admin

`server/lib/feed-reminders.ts` is built on `loadAllMemberships(scV1)` — roster,
embedded feeds, and `member.joined` as the clock. All three disappear:

- Roster → scan `membership` where the row is live and arkPlus is true
- `joined` → the new `membership.created_at` (or the feed's own `created`)
- `member.feeds` → one feed; `total` is 1, so `onlyIfNoneSetUp` collapses to
  "hasn't activated"
- `member.first_name` → `greetingFirstName` off Auth0 / the Beehiiv `First
  Name` custom field; keep the guard

New `GET /api/me/feeds/spotify` — session-authenticated, mints the JWT for the
caller's own subscription, 302s to the Beehiiv show page. Same-origin guard,
rate-limited, never logs the target URL.

`server/routes/sms.ts` → replace with `POST /api/me/feeds/email` calling
Beehiiv's `send-private-feed-email`, keeping the same-origin guard and 3/hour
limiter. Retire `/api/sc/send-setup-sms`.

Retire the SC backfill machinery entirely —
`server/lib/feed-activation-backfill.ts`, `server/lib/feed-activation-csv.ts`,
`server/routes/admin-feed-activations.ts`,
`scripts/backfill-feed-activations-from-csv.ts`, and the Spotify-CSV work.
Beehiiv's readable `activated` removes the blind spot they existed to
reconstruct.

`admin-feed-reminders.ts` / `src/routes/admin/feed-reminders.tsx` keep working;
their copy references Spotify one-click and multi-feed counts and needs a pass.

### Phase 6 — cutover and decommission

1. Verify in-browser: a premium member sees a feed URL on
   `/account/podcast-feed`, the Apple link opens, the webhook flips the badge,
   the Spotify redirect lands signed-in, and `/plus/inside-call-me-back` plays.
2. Verify the negative: cancel → period end → `downgradeToFree` → feed gone
   from `/api/me`.
3. Delete `server/lib/sc-client.ts`, `scripts/delete-sc-user.ts`, every `SC_*`
   env var (`.env`, `.env.example`, Vercel). Run `knip`.
4. Point `urls.podcastSupport` away from `help@supportingcast.fm`.
5. Abandon `spike/private-podcast-feeds`; note it so it isn't merged later.

## 7. Risks

**⛔ No way to mint a feed token (§2).** Blocks the migration outright, not just
a phase. Everything else here is tractable; this one is a question for Beehiiv.

**Premium push becomes load-bearing.** The likeliest way to ship this broken is
to leave `ensureSubscribedWithPremium` best-effort inside the first-activation
branch. Under SC it was a newsletter nicety; under Beehiiv it mints the feed.

**Gift expiry has no upstream enforcement.** SC expired gift feeds itself. If
the Phase 4 reconciler change is skipped or fails quietly, expired recipients
keep their feed indefinitely and nothing surfaces it.

**JWT endpoint not actually enabled.** 422 on both publications today; the
Spotify path is designed around it.

**Feed token rotation.** Anything keyed on `pod_feed_<uuid>` — mirror, `?feed=`
param, analytics id — breaks on reissue. Show id everywhere.

**Consolidation is a real cutover, just a small one.** Newsletter posts,
subscribers, sending domain and webhook registration all move publications. Do
it in one sitting and verify `/account/newsletters` after.

**Email becomes a load-bearing identifier.** SC keyed on an opaque
`sc_user_id` that survived an address change; Beehiiv keys the feed on the email
itself, and `beehiiv_subscription`'s primary key is the email too. There is no
email-change flow in the app today, so nothing is broken now — but this migration
makes one materially harder: whoever adds it must move the Beehiiv subscription
in the same transaction, or the member's feed silently vanishes with no error
anywhere. Worth a comment at the top of `beehiiv-feeds.ts` saying so.

**Env plumbing.** Per [[project-beehiiv-podcast-api]]: `??` vs `||` on blank
env vars, the `pod_` prefix requirement, and `.env.local` duplicate keys
(dotenv takes the last). All three have cost real time here before.

## 8. Files touched

New: `server/lib/beehiiv-feeds.ts`, `migrations/0022_beehiiv_feed_activations.sql`.

Modified: `server/routes/me.ts`, `server/routes/beehiiv.ts`,
`server/lib/feed-activations.ts`, `server/lib/feed-reminders.ts`,
`server/lib/activation.ts`, `server/lib/beehiiv-sync.ts`,
`server/entitlement.ts`, `server/lib/entitlement-resolver.ts`,
`server/routes/sms.ts`, `server/routes/podcasts.ts` (publication-var collapse),
`src/lib/auth.ts`, `src/lib/subscriberAuth.tsx`, `src/components/SetupFlow.tsx`,
`src/components/FeedSetupHub.tsx`, `src/components/PodcastFeedSetup.tsx`,
`src/routes/account/podcast-feed.tsx`, `src/data/shows.ts`, `.env.example`.

Deleted: `server/lib/sc-client.ts`, `server/routes/sc-webhook.ts`,
`server/lib/feed-activation-backfill.ts`, `server/lib/feed-activation-csv.ts`,
`server/routes/admin-feed-activations.ts`,
`scripts/backfill-feed-activations-from-csv.ts`, `scripts/delete-sc-user.ts`,
and their tests.

## 9. Suggested order

§5 (consolidation) first — nothing works until subscribers and the podcast are
in one publication. Then Phase 1 → 3 puts a real feed URL on the account page
behind the existing entitlement check: demoable alone, and the fastest proof
the migration works. Phases 2 and 4 land in either order after; 4 is the one
not to rush. 5 and 6 trail.

---

## 10. What shipped (2026-09-10)

Implemented in one pass once Beehiiv's fix landed. Every phase above is done.

**New**
- `server/lib/beehiiv-feeds.ts` — `fetchPrivateFeed` (60s TTL cache, 404 → null,
  422 logged loudly) and `buildSpotifyHandoff`.
- `server/routes/feed-actions.ts` — `POST /api/me/feeds/email` (Beehiiv sends its
  own transactional feed email) and `GET /api/me/feeds/spotify` (302 hand-off).
- `migrations/0023_beehiiv_feed_activations.sql` — the new mirror + webhook
  ledger, drops the SC tables and `membership.sc_user_id`, adds
  `beehiiv_subscription.premium_since`.

**Changed**
- `/api/me` renders the Beehiiv feed keyed on the session email. The wire `id` is
  the SHOW id, not the rotating `pod_feed_<uuid>` token.
- `/api/beehiiv/webhook` also handles `podcasts.private_feed.*`, dispatched
  BEFORE the `data.email` guard (those events nest the email under
  `data.subscription`). Idempotency ledger keyed on `uid`, written after success.
- The reconciler's arkPlus axis inverted: roster = premium mirror rows, projected
  onto a membership row through Auth0. A failed or empty projection NEVER
  revokes. `ReconcileSummary.scRemoved` → `arkPlusRemoved`.
- The reminder cron scans `beehiiv_subscription` bounded by `premium_since`
  instead of paging an upstream roster.
- The resolver's SC-by-email fallback (2b) is gone; `scFallback` → `emailFallback`.
- Gift redemption grants the Beehiiv tier. ⚠ The grant carries no end date, so
  the Neon expiry + the reconciler are now the ONLY things that end a gift.
- Setup UI: single feed renders `SetupFlow` directly (no hub), Castro added,
  YouTube Music removed, SMS replaced by the Beehiiv email.

**Removed** — `sc-client.ts`, `sc-webhook.ts`, `sms.ts`,
`admin-feed-activations.ts`, both feed-activation backfills,
`scripts/{delete-sc-user,backfill-membership}.ts`, the SC pass of
`backfill-subscriber-names.ts`, the admin "backfill from listening history"
panel, `urls.podcastSupport`, and every `SC_*` env var.

### Verified in the browser, 2026-09-10

`/account/podcast-feed` renders Giraffe Sandbox | Ark+ with Beehiiv's own title
and artwork; Apple/Overcast/Pocket Casts/Castro deep links carry the private
token; the QR, the raw feed URL and "email me the link" all render. `POST
/api/me/feeds/email` returned 200 and Beehiiv sent the mail. `GET
/api/me/feeds/spotify` 302s to the show page (403 cross-origin, 401
unauthenticated). `/plus/inside-call-me-back` plays a real Beehiiv episode, and
the show appears in `/podcasts` badged Ark+.

### One bug this found

The Spotify hand-off 503'd against a real member. Beehiiv's subscription id is
**per publication**, and the mirror row still held `sub_2a0db065…` on the
abandoned Call me Back publication from before the consolidation — so the JWT
mint against Ark Media failed with nothing in the response saying why. Fixed by
resolving through `refreshSubscriptionFromBeehiiv` (re-resolves by email against
the configured publication and heals the row) rather than reading the mirror
directly. Regression test in `server/feed-actions.test.ts`.

### Deliberately not done

The public show page's title/artwork still come from `src/data/shows.ts`, not
Beehiiv. That is the right split, not an omission: `shows.ts` is the site's own
naming layer (nav, browse grid, routes, SEO — all static at module scope), while
Beehiiv's title is what lands in the member's podcast app, which is why the SETUP
page reads it live. Making only `ShowPage`'s `<h1>` dynamic would leave the nav
and grid disagreeing with it.

### Still open

- `BEEHIIV_PODCAST_ID_INSIDE_CALL_ME_BACK`, `BEEHIIV_SUBSCRIBER_HOST` and
  `BEEHIIV_PREMIUM_TIER_ID` need setting in Vercel.
- Register `podcasts.private_feed.*` on the Beehiiv webhook (same URL/secret as
  the subscription events).
- Disable the Plus tier's two Beehiiv-native prices (§4) — a Beehiiv-direct buyer
  would otherwise get the feed with no Neon row and be revoked nightly.
- The §5 consolidation ops (move posts/subscribers, `mail.ark-plus.xyz`).
- Test subscribers left in Beehiiv: `hannah.waxman8+test@`, `+mint0910@`.
