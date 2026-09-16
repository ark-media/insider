# Private video — Ark+-gated, self-hosted, seamless upload

Status: draft. Scope is a new entitlement-gated media surface. Provider choice
(**Mux vs. Cloudflare Stream**) is deliberately deferred — the design isolates it
behind one adapter module so it can be named without reshaping anything else.

Goal: let Ark+ members watch videos we own, embedded on our own pages, such that
a shared link is useless to a non-subscriber — while the **production team uploads
with a drag-and-drop flow** from the existing `/admin` back office.

---

## 0. Why not YouTube unlisted / Spotify private feed

Rejected. Both fail the core requirement ("a subscriber can't share it").

- **Unlisted YouTube** = anyone with the link watches, no auth. The video ID sits
  in our page source; a member copies `youtube.com/watch?v=…` and the recipient
  never touches our site. *Private* YouTube requires the viewer to be signed into
  a Google account we granted — unembeddable for arbitrary Ark+ users, no
  per-viewer signed-embed API.
- **Spotify private feed** is a per-listener tokenized RSS meant for the Spotify
  app, not an on-site embed authenticated with our token. Spotify's `<iframe>`
  player only serves public catalog content.

The only design that enforces entitlement on the *media itself* is media **we
host**, delivered via **short-TTL, per-user signed playback tokens** minted only
after a server-side entitlement check. That is this PRD.

Honest limit: signed tokens stop casual link-sharing (the stated goal). They do
**not** stop a determined member screen-recording during the token window — that
is DRM territory (Widevine/FairPlay), out of scope for launch. Both candidate
providers support DRM later without a redesign.

---

## 1. Decisions

### 1a. Managed provider, not self-hosted bytes — and why performance is a non-issue

Video is served from the provider's CDN (adaptive HLS) straight to the viewer.
**The bytes never traverse our Vercel functions or egress.** Consequences:

- **Video count has near-zero impact on site performance.** 10 videos or 10,000,
  our site serves the same payload per view: one Neon row + a player component.
  Our per-video footprint is a single Postgres row; per-*play* cost is one JWT
  sign (sub-ms, fine on Fluid Compute).
- The three things that actually scale — none of which is "library size":
  1. **Listing pages** — render posters, lazy-load, click-to-play, paginate.
     Never mount N players at once. (UI concern, §5.)
  2. **Provider cost** — billed per minute *stored* + per minute *delivered*. A
     cold back-catalog is storage-only. This is a billing line, not a ceiling.
  3. **Upload/transcode** — async on the provider; a heavy upload day doesn't
     touch site speed.

This is the decisive reason to reject self-hosting in Vercel Blob: there every
play pulls bytes through *our* egress and we own transcoding — the one path where
video count does degrade the site.

### 1b. Provider deferred behind one adapter — `server/lib/video-provider.ts`

The only module that knows the provider. Exports exactly three functions:

```
createUploadUrl(meta): { uploadUrl, providerAssetId }   // one-time resumable URL
signPlayback(playbackId): string                        // short-TTL signed token/URL
parseWebhook(req): { providerAssetId, playbackId, status, durationS } | null
```

Everything else in the system is provider-neutral. The `video.provider` column
(§2) records which one produced a row, so we can even run both concurrently or
migrate the catalog later. "Decide later" therefore costs nothing structurally;
picking a provider adds only this file's internals, the uploader component (§4),
and one signing key in env.

Recommendation when the call is made: **Mux** for the strongest drop-in uploader
(`<MuxUploader>`) and player for a non-technical production team; **Cloudflare
Stream** if cost is the priority (cheaper per-minute, more DIY uploader).

### 1c. The gate reuses the existing entitlement resolver — no new auth

Playback is gated by `deriveEntitlements(tier)` in `server/entitlement.ts`. A
video declares which entitlement it needs (`required_ent`, default `arkPlus`).
No new tier, no new claim, no app_metadata mirror — consistent with "Auth0
answers who you are, never what you can access" (entitlement-tiers.md §2).

Admin upload is gated by the **same guard `adminRoutes` already uses** (Auth0
role claim). The production team logs into the `/admin` they already have.

### 1d. Neon stores metadata + opaque IDs only

No PII, opaque provider IDs only — consistent with the `membership` invariant.
Next migration in sequence is **`0014`** (after `0013_cancellation_reasons_array`).

---

## 2. Data model — migration `0014_video.sql`

```sql
-- 0014_video.sql
-- Ark+-gated video catalog. Bytes live on the provider CDN; Neon holds only
-- metadata + opaque provider ids (no PII), consistent with the membership
-- invariant. Playback entitlement is DERIVED via server/entitlement.ts —
-- required_ent names which axis the row demands.
create table if not exists video (
  id            text primary key,               -- our slug/uuid, used in URLs
  provider      text not null,                  -- 'mux' | 'cf-stream' (the §1b seam)
  provider_asset_id text not null,              -- provider's upload/asset handle
  playback_id   text,                           -- provider playback id; NULL until 'ready'
  title         text not null,
  show_slug     text,                           -- ties into existing show model
  episode_ref   text,
  required_ent  text not null default 'arkPlus',-- 'arkPlus' | 'circle'
  status        text not null,                  -- uploading | processing | ready | errored
  duration_s    integer,
  published     boolean not null default false, -- admin toggles visibility to members
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists video_show_idx on video (show_slug);
create index if not exists video_published_idx on video (published, created_at);
```

`required_ent` is a free-text-typed axis key; the playback route must fall back
to deny (not throw) on an unknown value, mirroring the `deriveEntitlements`
unknown-tier guard.

---

## 3. Server routes — `server/routes/videos.ts`

New route bundle registered in `server/dev-api.ts` alongside `meRoutes` /
`adminRoutes` (and therefore live in the single `api/handler.ts` prod function).

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/admin/videos/upload-url` | admin guard | Call `createUploadUrl()`, write a `status:'uploading'` row, return the one-time resumable URL. Upload goes **browser → provider**, never through the function (no size/timeout limit, no egress cost). |
| `PATCH /api/admin/videos/:id` | admin guard | Set/edit title, show, episode, `required_ent`, `published`. |
| `GET /api/admin/videos` | admin guard | List for the admin table (all statuses). |
| `POST /api/webhooks/video` | provider signature | `parseWebhook()` → on "ready" flip row to `ready`, store `playback_id` + `duration_s`. Mirrors `server/routes/sc-webhook.ts`. Verify the provider signature; ignore unrecognized events. |
| `GET /api/videos` | member session | Published, entitled rows only, paginated — for member listing pages. |
| `GET /api/videos/:id/playback` | member session | **The gate.** Resolve tier → `deriveEntitlements(tier)[row.required_ent]`. If true and `published` and `ready`, return `signPlayback(playback_id)`; else 403. No `ark_session` ⇒ no token ⇒ shared link is dead. |

Playback-token TTL: short (target ~a few minutes), refreshed by the player as it
streams. Long enough to start playback, short enough that a leaked token expires
before it's useful to share.

---

## 4. Admin upload UX — `src/routes/admin/videos.tsx`

Gated by the existing `AdminGuard` / `AdminShell`, listed in the admin nav next
to `feed-reminders` / `announcements`.

Flow for the production team:
1. Drag a file onto a drop-zone uploader component (provider-specific, ~a few
   lines — Mux's `<MuxUploader>` is drag-drop + resumable + progress out of the
   box). It POSTs to `/api/admin/videos/upload-url` and uploads directly to the
   provider.
2. Progress bar; on completion the row is `processing`. The provider webhook
   flips it to `ready` shortly after — the admin table reflects status live
   (poll or refresh).
3. A metadata form (title, show, episode, `required_ent`, publish toggle)
   PATCHes the row. Nothing is visible to members until `published` is set.

Non-negotiable for "seamless": the upload never blocks on transcode, and the team
never touches the provider's own dashboard or any ID by hand.

---

## 5. Member playback — `<GatedVideo id=… />`

- Calls `GET /api/videos/:id/playback`, receives the signed token, renders the
  provider's player. 403 → an upsell/"Ark+ members only" state (ternary render,
  never `&&`).
- **Listing pages must not mount many players.** Render poster + duration; a
  click swaps in the player and fetches the token then. Paginate via
  `GET /api/videos`. This is the only place library size touches performance, and
  it's bounded by pagination regardless of catalog depth (§1a).

---

## 6. Environment / provider account (deferred until §1b resolved)

- Provider API key (server-side, for `createUploadUrl` + webhook verify).
- Provider **signing key** for `signPlayback` (the whole gate depends on this;
  playback policy must be set to *signed*, not public, on the provider side).
- Webhook secret for `POST /api/webhooks/video`.
- Set `published=false` default so nothing leaks before the metadata pass.

---

## 7. Open decisions

1. **Provider** — Mux vs. Cloudflare Stream (§1b). Everything else is buildable
   now; this only fills the adapter + uploader + keys.
2. **Which entitlement gates video** — `arkPlus` only, or should `circle`/`bundle`
   see some? Default here: `required_ent = 'arkPlus'`, per-video overridable.
3. **DRM** — deferred. Revisit only if screen-capture piracy proves real.
4. **Analytics** — Mux ships view analytics; if we pick Cloudflare, decide whether
   to instrument plays through the existing PostHog layer (`src/lib/analytics.ts`).

---

## 8. Non-goals

- Live streaming (VOD only).
- Public/marketing video (this surface is members-only by construction).
- Migrating existing YouTube/Spotify content automatically — production re-uploads
  owned masters through the new flow.
- Preventing authenticated screen capture (DRM; §0, §7.3).
