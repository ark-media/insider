# PRD: Dynamic, DB-backed Israel Votes page

## Self-Clarification

1. **Problem/Goal:** The `/israel-votes` page is fully hardcoded — a featured YouTube video, three "explainer" cards, and a 12-track audio playlist, all with hand-pasted Simplecast mp3 URLs (`src/routes/israel-votes.tsx`). Every time the network publishes a relevant episode, an engineer has to edit code and redeploy. This violates the project rule that episode data is always sourced from Simplecast at runtime, never hardcoded. We want the page to populate itself from Simplecast episodes that producers tag with the keyword `israel votes`, with a thin admin layer for the things Simplecast can't provide (YouTube pairing, ordering, section placement).

2. **Core Functionality:**
   - A scheduled (cron) sync reads Simplecast episodes tagged `israel votes` (case-insensitive) across the public shows and stores them in Neon.
   - The public page renders entirely from the DB: a featured video, explainer cards, and an audio playlist.
   - An admin screen lets a producer set each episode's YouTube ID, section placement, display order, and enabled flag — values the sync never overwrites.

3. **Scope/Boundaries (what this explicitly does NOT do):**
   - Does **not** invent a YouTube↔Simplecast auto-match. Simplecast stores no YouTube link (verified against the live API); YouTube IDs are entered manually in admin.
   - Does **not** use Simplecast webhooks. Simplecast exposes no webhook management API (`/webhooks` 404s; only RSS WebSub exists, which carries no keyword data and does not fire on metadata-only edits). A cron-driven sync is the source of truth.
   - Does **not** scan paid shows. Only the 4 public shows in `src/data/shows.ts` (Call Me Back, For Heaven's Sake, What's Your Number, Ark News Daily). Inside Call Me Back is paid/commented out — its current "Sneak Peek" track will not carry over.
   - Does **not** backfill Simplecast tags. Episodes that should appear must be tagged `israel votes` in the Simplecast dashboard by producers. This PRD provides the list to tag.
   - Does **not** change the visual design, copy, or `PageShell` framing of the page beyond making the three sections data-driven.

4. **Success Criteria:**
   - `israel_votes_episodes` table exists in Neon; a sync run upserts every public-show episode tagged `israel votes` and leaves admin-owned columns untouched on re-sync.
   - `GET /api/israel-votes` returns enabled rows grouped by placement; the page renders featured/explainers/playlist from that response with working loading and empty states.
   - An admin can change a row's YouTube ID, placement, order, and enabled flag and see it reflected on the public page after save; a subsequent sync does not revert those edits.
   - `npm run` quality checks (typecheck, lint, tests) pass; new unit tests cover the sync filter, admin-input validation, and row mapping.

5. **Constraints:**
   - **Greenfield / pre-launch:** no backward-compatibility needed; a clean breaking replacement of the hardcoded page is fine.
   - **Simplecast rate limits:** keywords live only on the per-episode resource (the list endpoint omits them). Bulk scanning triggers HTTP 429. The sync must throttle (bounded concurrency + delay) and retry on 429. This is why it runs as a background cron, not at request time.
   - **Existing conventions:** Neon HTTP client via `getDb(env)` and tagged-template SQL (`server/lib/db.ts`); numbered SQL files in `migrations/`; pure-validator + DB-accessor lib split (`server/lib/careers.ts`); `requireAdmin`-gated `/api/admin/*` routes; `CRON_SECRET` bearer auth for cron (`server/routes/cron.ts`); route modules aggregated in `server/dev-api.ts`; shared types in `shared/`; ternary (`? :`) for conditional JSX.
   - **Token naming:** the Simplecast token is `SIMPLECAST_API_TOKEN`; podcast IDs are `VITE_SIMPLECAST_PODCAST_ID_<SHOW>`. (`SC_API_KEY` is Supporting Cast — unrelated.)

---

## 1. Introduction/Overview

Replace the hardcoded `/israel-votes` page with a dynamic one driven by Simplecast keyword tagging. A Vercel cron job periodically scans the public shows for episodes tagged `israel votes`, stores them in a Neon table, and the public page renders from that table. Because Simplecast cannot supply YouTube videos or editorial ordering/placement, a small admin screen lets producers attach a YouTube ID and decide whether each episode appears as the featured video, an explainer card, or a playlist row. The sync owns the Simplecast-derived columns; the admin owns the editorial columns, and the two never clobber each other.

## 2. Goals

- Eliminate hardcoded episode data on `/israel-votes`; episodes flow from Simplecast tags.
- Adding an episode to the page becomes a producer action (tag in Simplecast) + optional admin touch (YouTube/placement), with no code change or deploy.
- Stay within Simplecast rate limits via a throttled background sync.
- Preserve the page's existing look, structure, and copy.
- Keep editorial decisions (YouTube pairing, ordering, placement, visibility) in the admin back office, durable across syncs.

## 3. Tasks

### T-001: Neon migration for `israel_votes_episodes`
**Description:** Create the table that stores synced episodes plus admin-owned editorial fields. Sync-owned and admin-owned columns are distinct so upserts can update one without touching the other.

**Acceptance Criteria:**
- [ ] New file `migrations/0005_israel_votes_episodes.sql`.
- [ ] Columns: `id` (uuid PK, matching the careers table's id strategy), `simplecast_id text not null unique`, `show_slug text not null`, `title text not null`, `published_at date`, `enclosure_url text`, `image_url text`, `youtube_id text` (nullable), `placement text not null default 'playlist'` with a CHECK constraint in (`'featured'`,`'explainer'`,`'playlist'`), `display_order integer not null default 0`, `enabled boolean not null default true`, `synced_at timestamptz`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`.
- [ ] Index on (`enabled`, `placement`, `display_order`) for the public read.
- [ ] Migration applies cleanly against the `ark-insider` Neon project.

### T-002: Shared type
**Description:** Add the shared `IsraelVotesEpisode` type used by server and client.

**Acceptance Criteria:**
- [ ] New `shared/israel-votes.ts` exporting `IsraelVotesEpisode` (camelCase fields mirroring the table) and a `Placement` union.
- [ ] Typecheck passes.

### T-003: DB accessor + validation lib
**Description:** Create `server/lib/israel-votes.ts` mirroring `server/lib/careers.ts`: `COLUMNS`, `mapRow`, public/admin list accessors, sync upsert, admin update, and a pure validator for admin input.

**Acceptance Criteria:**
- [ ] `listEnabled(sql)` returns enabled rows ordered by `placement` then `display_order` then `published_at`.
- [ ] `listAll(sql)` returns all rows for the admin view.
- [ ] `upsertSynced(sql, fields)` inserts or, `ON CONFLICT (simplecast_id) DO UPDATE`, updates **only** `show_slug, title, published_at, enclosure_url, image_url, synced_at` — never `youtube_id, placement, display_order, enabled`.
- [ ] `updateAdminFields(sql, id, input)` updates only `youtube_id, placement, display_order, enabled, updated_at`.
- [ ] `validateAdminInput(raw)` returns a normalized value or an error string: `placement` must be one of the three; `display_order` must be an integer; `youtube_id` must be empty/null or match a YouTube video-ID shape (`^[A-Za-z0-9_-]{11}$`); `enabled` coerced to boolean.
- [ ] `mapRow` converts snake_case DB rows to the shared camelCase type.

### T-004: Simplecast keyword sync engine
**Description:** Create `server/lib/israel-votes-sync.ts` that scans the public shows for the `israel votes` keyword and upserts matches. Pure of the cron transport so it is unit-testable with an injected fetch.

**Acceptance Criteria:**
- [ ] Resolves the public-show podcast IDs from env (`VITE_SIMPLECAST_PODCAST_ID_*`) using the same 4 public shows as `src/data/shows.ts`.
- [ ] For each show, paginates the episodes list (`limit=50`, following `pages`), then fetches each episode to read `keywords.collection[].value`.
- [ ] Keyword match is case-insensitive and trims whitespace; the keyword constant is `israel votes`.
- [ ] Captures synced fields from the episode payload: `id`, `title`, `published_at` (date only), `enclosure_url`, `image_url`, `show_slug`.
- [ ] Throttles requests (bounded concurrency, e.g. ≤4, with a small inter-request delay) and retries HTTP 429 with backoff.
- [ ] Page-depth is capped/configurable (default: all pages) so a runaway catalog can be bounded.
- [ ] Returns a summary `{ scanned, matched, upserted, errors }`.
- [ ] Unit test (injected fake fetch) proves: only tagged episodes are upserted; matching is case-insensitive; a 429 is retried; paid shows are never requested.

### T-005: Cron route + schedule
**Description:** Add `/api/cron/sync-israel-votes` to `server/routes/cron.ts` with the same `CRON_SECRET` bearer auth as the existing reconcile cron, and register a schedule in `vercel.json`.

**Acceptance Criteria:**
- [ ] Route rejects requests without a valid `Authorization: Bearer <CRON_SECRET>` (401), using constant-time comparison like the existing cron.
- [ ] Returns 500 if `SIMPLECAST_API_TOKEN` or `DATABASE_URL` is missing, with a clear message.
- [ ] On success returns the sync summary as JSON.
- [ ] `vercel.json` `crons` gains an entry for the new path on a 6-hour schedule (`0 */6 * * *`).

### T-006: Public read API
**Description:** Add `GET /api/israel-votes` returning enabled rows grouped by placement. New `server/routes/israel-votes.ts`, registered in `server/dev-api.ts`.

**Acceptance Criteria:**
- [ ] Returns `{ featured: Episode | null, explainers: Episode[], playlist: Episode[] }` from enabled rows, ordered by `display_order` then `published_at` desc.
- [ ] At most one `featured` (first by order); extras fall through to playlist or are ignored deterministically.
- [ ] Returns empty groups (not an error) when the table is empty or `DATABASE_URL` is unset.
- [ ] Registered in `dev-api.ts` alongside the other route modules.

### T-007: Admin API
**Description:** Add `/api/admin/israel-votes` (`requireAdmin`-gated) for listing, editing, deleting rows, and triggering an on-demand sync. New routes in `server/routes/israel-votes.ts` (or an admin sibling), registered in `dev-api.ts`.

**Acceptance Criteria:**
- [ ] `GET` returns all rows (enabled or not) for the admin table; 403 when not admin.
- [ ] `PUT ?id=` validates via `validateAdminInput` and updates admin-owned fields only; 400 on invalid input, 404 on unknown id.
- [ ] `DELETE ?id=` removes a row (used to drop episodes that were tagged by mistake); 404 on unknown id.
- [ ] `POST` (e.g. `?action=sync`) runs the sync engine and returns its summary; 403 when not admin.
- [ ] All handlers gated by `requireAdmin`.

### T-008: Admin UI screen
**Description:** Add `src/routes/admin/israel-votes.tsx` mirroring the careers admin layout: a table of synced episodes with inline controls for YouTube ID, placement, display order, enabled, plus a "Sync now" button. Link it from the admin index.

**Acceptance Criteria:**
- [ ] Table lists all rows with show, title, published date, placement, order, enabled, and YouTube ID.
- [ ] Each row can edit `youtube_id`, `placement` (select: featured/explainer/playlist), `display_order`, `enabled`, and save via the admin `PUT`.
- [ ] A "Sync now" button calls the admin sync `POST` and shows the resulting summary (scanned/matched/upserted/errors).
- [ ] A row can be deleted with confirmation.
- [ ] Validation errors from the API are surfaced inline.
- [ ] Linked from the admin index nav.
- [ ] Quality checks pass; **verify in browser** (admin auth via the browser-test auth bridge).

### T-009: Public page rewrite
**Description:** Rewrite `src/routes/israel-votes.tsx` to fetch `/api/israel-votes` and render the three sections from data, replacing the hardcoded `EXPLAINERS`/`PLAYLIST`/`FEATURED_VIDEO_ID` constants. Keep the existing `PageShell` framing, section styling, and copy.

**Acceptance Criteria:**
- [ ] Featured section renders the `featured` row's YouTube embed when present; section hidden when absent.
- [ ] Explainers render each `explainer` row: YouTube embed (if `youtube_id`) + `enclosure_url` audio.
- [ ] Playlist renders each `playlist` row with the existing expand-to-play interaction, using `enclosure_url`.
- [ ] Loading state while fetching; empty state when all groups are empty.
- [ ] Conditional rendering uses ternary (`? :`), not `&&`.
- [ ] No hardcoded episode/mp3/video constants remain in the file.
- [ ] Quality checks pass; **verify in browser**.

### T-010: Tagging backfill list (handoff doc)
**Description:** Produce the list of episodes currently hardcoded on the page (title + Simplecast episode ID + show) so producers can tag them `israel votes` in Simplecast. Note which are already tagged.

**Acceptance Criteria:**
- [ ] A checklist (committed under `tasks/` or shared with the user) maps each of the current 12 tracks + 3 explainers + featured video to its Simplecast episode (where one exists), flags the ICMB track as out of scope (paid), and notes the 2 already-tagged episodes.

## 4. Functional Requirements

- FR-1: The system must store Israel Votes episodes in a Neon table with distinct sync-owned and admin-owned columns.
- FR-2: A cron job must, on a 6-hour schedule, scan the 4 public shows' Simplecast episodes and upsert those whose `keywords` include `israel votes` (case-insensitive).
- FR-3: Re-running the sync must not overwrite admin-owned fields (`youtube_id`, `placement`, `display_order`, `enabled`).
- FR-4: The sync must throttle requests and retry HTTP 429, and must never request paid shows.
- FR-5: `GET /api/israel-votes` must return enabled episodes grouped into `featured`, `explainers`, and `playlist`.
- FR-6: The public page must render all three sections from that endpoint, with loading and empty states, and no hardcoded episode data.
- FR-7: Admins must be able to set an episode's YouTube ID, placement, display order, and enabled flag, and trigger a sync on demand, via `requireAdmin`-gated endpoints.
- FR-8: YouTube IDs must be validated to the 11-char YouTube video-ID shape; placement must be one of the three allowed values.
- FR-9: An episode tagged in Simplecast but not yet given a placement must default to the `playlist` section.

## 5. Non-Goals (Out of Scope)

- Automatic YouTube↔Simplecast matching (Simplecast has no such link; YouTube IDs are entered manually).
- Simplecast webhook integration (no webhook API exists; cron is the mechanism).
- Scanning paid shows or Inside Call Me Back; the current ICMB track will not carry over.
- Backfilling Simplecast tags on existing episodes (a producer task; this PRD supplies the list).
- Redesigning the page's visuals, copy, or layout beyond making sections data-driven.
- A generic "keyword collection page" framework for arbitrary tags — this is scoped to `israel votes` only (the keyword is a constant; generalization can come later).

## 6. Technical Considerations

- **Rate limits:** keywords are only on `/episodes/{id}`, not the list endpoint; bulk scans hit 429. Mitigated by bounded concurrency + backoff in the sync, and by running off-request as cron. In-process caching is not required because reads come from Neon, not Simplecast.
- **Pagination depth:** full-catalog scans can be hundreds of calls per cold sync; page-depth is configurable so it can be capped if rate limits bite.
- **Audio:** `enclosure_url` (raw mp3) is present in the Simplecast list response, so playback stays as native `<audio>` like today; no extra fetch needed for audio.
- **Auth:** cron uses `CRON_SECRET` bearer; admin uses `requireAdmin` (Auth0 role claim) — both already established patterns.
- **Data ownership:** sync upsert touches only Simplecast-derived columns; admin update touches only editorial columns. This separation is the core invariant (FR-3).
- **First-run reality:** only ~2 episodes are currently tagged, so the page will be sparse until T-010's backfill tagging is done in Simplecast.

## 7. Success Metrics

- Adding a new Israel Votes episode to the page requires zero code changes once tagged (and, if a video is wanted, one admin edit).
- A full sync completes without unhandled 429s and within the cron's runtime budget.
- After an admin sets YouTube/placement/order, a subsequent sync leaves those values unchanged (verified by test + manual check).
- Public page renders correctly with real Neon data, including empty/loading states.

## 8. Open Questions

- **Cron frequency:** 6 hours is the proposed default. Election news can move fast near a vote — should it tighten to hourly during the campaign window?
- **Scan depth:** default is full catalog (throttled). If 429s prove problematic, cap to the N most-recent pages per show — acceptable since election content is recent.
- **Featured selection:** when multiple rows are marked `featured`, the first by `display_order` wins. Is a single-featured constraint (enforced in admin) preferable to silent fallthrough?
- **Ark News Daily:** it's a public show and will be scanned; confirm its daily episodes are acceptable in the playlist if tagged, or whether it should be excluded from this specific collection.
