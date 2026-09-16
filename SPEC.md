# SPEC — The Fold's web feed for Ark+ subscribers

Status: Draft for approval
Scope: The `/fold` route (`src/routes/fold.tsx`) and its Circle data layer
(`src/lib/circle.ts`). Decided via product interview; see "Decisions" below.

---

## 1. Objective

Give a **logged-in Ark+ subscriber** a personalized, **read-only** window into their
Fold when they land on `/fold`, while keeping the app the home of all
engagement. Non-subscribers keep today's marketing showcase unchanged.

The web surface exists to make the Fold feel **alive and personal** and to pull
members back **into the app** for time-sensitive moments (live Q&As, events) and new
activity — not to become a second client. Every action (like, reply, post, RSVP) leaves
the website and opens Circle.

### Target users
- **Ark+ subscriber, signed in** — the only audience for the new feed experience.
- **Everyone else** (guest, logged-in non-subscriber) — unchanged marketing showcase +
  "Join Ark+" CTA.

### Decisions (locked via interview)
| Question | Decision |
|---|---|
| What the web feed is | **Read-only teaser** — preview content, every action deep-links into the app |
| What to surface | Upcoming & live events · latest feed posts · live Q&A in progress · activity since last visit |
| Personalization | **Scoped to the member's joined spaces** (true "my feed") |
| Live signal prominence | **In-page only** — no site-wide banners or nav badges in v1 |
| Marketing showcase for subscribers | **Replaced** by the feed (members aren't re-sold) |
| Empty / quiet feed | **Onboarding nudge** — "join a space" with most-active spaces |
| Data freshness | **Fetch on load + poll ~45s** while tab is open; no websockets |

### Sequencing — v1 vs v2 (important)
Per-user personalization and "since last visit" require **authenticated per-member reads
from Circle** (member-scoped token via the `/circle-sso` bridge or Circle's Headless
Member API). Today `src/lib/circle.ts` only mocks the **admin** token path.

- **v1 (this spec — ships on the existing admin/mock data path):**
  live + upcoming events strip · curated Fold-highlights feed (same for every
  subscriber) · onboarding empty state · persistent "Open in app" card · 45s polling.
  Subscriber view replaces the marketing showcase. **No per-user auth to Circle.**
- **v2 (later, after member-auth reads exist):** swap the highlights feed for the true
  per-space personalized feed and enable the "since you were last here" digest.

The **layout and components are identical across v1 and v2** — only the data source
behind the feed section changes. v1 must be built so that swap is a data-layer change,
not a UI rewrite.

---

## 2. Commands

Existing project scripts (no new tooling introduced):

| Command | Purpose |
|---|---|
| `bun run dev` | Local dev server (Vite) |
| `bun run build` | `routes` + `tsc -b` + `vite build` |
| `bun run lint` | ESLint |
| `bun test` | Run unit tests (Bun test runner) |

---

## 3. Project structure

Files touched / added for v1:

```
src/
  routes/
    fold.tsx               # MODIFIED — subscriber branch renders the feed; guest branch unchanged
  lib/
    circle.ts              # MODIFIED — add v1 read fns returning the v2-stable shapes
  data/
    events.ts              # REUSED — upcomingEvents(), live/upcoming derivation
    communityBroadcasts.ts # REUSED — source for the v1 curated highlights feed
  components/
    community/             # NEW (optional) — extract feed UI if fold.tsx grows large
      LiveEventsStrip.tsx
      CommunityFeed.tsx
      FeedEmptyState.tsx
```

Guidance:
- Keep the existing `PhoneFrame` / mockup components in `fold.tsx` for the
  **non-subscriber** showcase; do not delete them.
- Only extract new components if the subscriber branch makes `fold.tsx`
  unwieldy (> ~450 lines). Prefer co-locating small helpers in the route first.

### Data contract (must be stable v1 → v2)
`src/lib/circle.ts` exposes read functions whose **return shapes do not change** when the
backing source swaps from mock/admin (v1) to per-member Circle reads (v2):

```ts
// Live/upcoming events for the strip
fetchUpcomingEvents(): Promise<ArkEvent[]>          // already exists

// Feed posts. v1: curated highlights (same for all). v2: member's joined-space feed.
fetchCommunityFeed(): Promise<CommunityFeedItem[]>  // NEW

// Per-member digest. v1: returns null (not available). v2: real unread/replies.
fetchActivityDigest(): Promise<ActivityDigest | null> // NEW, v1 returns null

// Spaces to suggest in the empty state.
fetchSuggestedSpaces(): Promise<SuggestedSpace[]>   // NEW
```

`CommunityFeedItem`, `ActivityDigest`, `SuggestedSpace` are defined in `circle.ts` (or a
co-located types file) and projected from the mock data in v1. The UI consumes only these
types — never the raw `CommunityBroadcast` shape directly.

---

## 4. Code style

Follow the existing codebase conventions — no new patterns:
- **TanStack Router** file routes (`createFileRoute`), **React** function components,
  **Tailwind v4** utility classes with the project's design tokens
  (`text-fg-strong`, `border-rule`, `bg-navy-800`, `text-cyan`, etc.).
- Auth gating via `useSubscriberAuth()`; subscriber = `state.kind === "member" &&
  state.me.tier === "subscriber"`. Render `null` while `state.kind === "loading"`
  (matches current `fold.tsx`).
- **Conditional JSX uses ternary `? … : null`, never `&&`** (project rule).
- App mockup/phone screens keep **fixed dark colors** (not theme tokens) so they read as
  app screenshots in both light and dark site themes — but the **real subscriber feed is
  page content** and SHOULD use theme tokens.
- Deep links go through existing helpers: `circleEventLink(id)`, `CIRCLE_OPEN_LINKS`,
  and the `/circle-sso?return_to=…` bridge for landing members in a specific space.
- Episode/event/Fold data is **never hardcoded in components** — always read through
  the `circle.ts` data functions (mirrors the "fetch at runtime" project rule).

---

## 5. Testing strategy

`bun test` unit tests for the data/logic layer; manual browser verification for UI.

**Unit tests (required for v1):**
- `circle.ts`:
  - `fetchCommunityFeed()` returns items in the `CommunityFeedItem` shape (projection
    from `communityBroadcasts` is correct — no raw fields leak through).
  - `fetchActivityDigest()` returns `null` in v1.
  - `fetchSuggestedSpaces()` returns a non-empty list.
- Live/upcoming derivation: given a fixed `now`, an event whose window contains `now` is
  classified **live**; a future event is **upcoming**; a past event is excluded. (Pass an
  injectable `now` — do not rely on wall-clock; mirrors `upcomingEvents(now)`.)

**Manual / browser verification (acceptance):**
1. **Subscriber** → `/fold` shows: live/upcoming events strip, Fold feed,
   persistent "Open in app" card. **No 01–04 marketing blocks.**
2. **Guest / non-subscriber** → `/fold` unchanged (marketing showcase + Join CTA).
3. Every feed/event action opens Circle (app links / `circle-sso`), no in-page write UI.
4. **Empty feed** → onboarding nudge with suggested spaces, each deep-linking to the app.
5. **Polling** → with a live event active, "● live now" appears within ~45s without a
   manual refresh.
6. `bun run build` and `bun run lint` pass.

### Acceptance criteria (v1 done = all true)
- [ ] Subscriber sees feed + events + "Open in app"; marketing blocks hidden for them.
- [ ] Non-subscriber/guest experience is byte-for-byte unchanged.
- [ ] No like/reply/post/RSVP happens on the web — all actions deep-link into Circle.
- [ ] Empty/quiet feed renders the onboarding nudge, not a blank panel.
- [ ] Data flows through `circle.ts` functions whose shapes are v2-stable.
- [ ] `fetchActivityDigest()` returns `null` and the digest UI is hidden in v1.
- [ ] Polling refreshes live state ~every 45s while the tab is visible.
- [ ] Unit tests for the projection + live/upcoming derivation pass; lint + build pass.

---

## 6. Boundaries

**Always:**
- Gate the feed strictly to signed-in Ark+ subscribers; treat any non-subscriber as the
  marketing audience.
- Keep the web feed **read-only**; route every action into the Circle app.
- Read all Fold/event data through `src/lib/circle.ts` so v1→v2 is a data swap.
- Preserve the existing non-subscriber showcase and its mockup components.
- Use ternary for conditional rendering; use existing design tokens and deep-link helpers.

**Ask first:**
- Adding any **write** capability on the web (comment, like, post, RSVP).
- Promoting the live signal beyond the page (nav badge, site-wide banner, push) — out of
  v1 scope by decision.
- Introducing real-time transport (websockets/SSE) instead of polling.
- Pulling **member-authored personal feed** data before the v2 member-auth path exists
  (privacy: v1 shows only curated, permissioned highlights).

**Never:**
- Surface another member's private/joined-space content to a user who isn't authorized
  (no per-user reads in v1 — only editorially-permissioned `communityBroadcasts`).
- Hardcode event/post data inside components.
- Re-sell Ark+ to an existing subscriber on this page.
- Replace `minify: 'esbuild'` or otherwise touch build config for this feature.

---

## Open questions (non-blocking for v1)
- v2: which Circle path — `/circle-sso` member token vs Headless Member API — for
  authenticated per-space reads? (Decide before v2.)
- "Since last visit" baseline: server-stored last-seen timestamp vs client localStorage?
  (v2.)
