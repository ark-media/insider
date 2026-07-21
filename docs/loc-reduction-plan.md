# LOC-Reduction, DRY & Bug-Surface Plan

Goal: make the codebase terser, remove duplication, and shrink the places where
bugs and security risks can live. Synthesized from five parallel research passes
(frontend components, frontend routes/lib, server non-test, server tests,
security). Total addressable: **~5,100 LOC (~10% of ~50k)** plus the security
consolidations.

Runner is `bun test`. Test-runner is `bun test`; no dead-code tooling installed.

---

## Confirmed bugs & security gaps (fix regardless of LOC)

1. **Coupon amounts hardcode `$` in a multi-currency checkout.** Flagged by two
   independent agents. `src/components/CheckoutModal.tsx:583`,
   `src/routes/admin/promos.tsx:51`, `src/routes/admin/cancellations.tsx:71`,
   `src/routes/account/billing.tsx:29` all do `` `$${cents/100}` `` while the rest
   of the app localizes via `Intl` / `src/lib/currency.ts`. A JPY/ILS buyer sees
   the wrong currency. **Fix:** one `formatCouponDiscount(promo, currency)` in
   `src/lib/currency.ts`; call from all sites.
2. **`/api/circle/space-posts` has no server-side entitlement gate** (High).
   `server/routes/circle.ts:490-517` returns rendered Ark+ `bodyHtml` to anyone,
   unlike gated sibling `community-feed` (`:440-465`). Not wired into the reader
   UI today, but live and reachable; the documented one-line `sourceBySlug` switch
   would leak paid content. **Fix:** `gateContentForRequest(req, env, tier)` helper;
   route both `space-posts` and `community-feed` through it.
3. ~~**Circle client reads two different token env vars.**~~ **FALSE POSITIVE —
   verified via .env.example comments.** `CIRCLE_API_TOKEN` is the Circle Admin
   **v1** token (member CRUD + reconciliation) and `CIRCLE_ADMIN_API_TOKEN` is the
   Admin **v2** token (broadcasts/feed reads). Two genuinely distinct tokens for
   two Circle API versions; the split is correct. A `circle-client.ts` can still
   share fetch/header/error plumbing in Phase 4 but MUST keep both tokens (v1 +
   v2 clients). No bug.
4. **Request-identity resolution triplicated with divergent precedence.** Flagged
   by server + security agents. `server/lib/session.ts:302-321` and
   `server/lib/entitlement-resolver.ts:47-71` check Bearer→session→cookie;
   `server/routes/me.ts:155-176` checks session→Bearer→cookie. **Fix:** make
   `resolveRequestIdentity` the single source; `getSessionEmail` delegates; delete
   the me.ts inline block.
5. **Init-failure handler leaks stack + message to client.**
   `server/dev-api.ts:184-198` returns `initError.message`/`.stack`; the
   per-request handler below (`:233-239`) correctly returns generic. **Fix:** log
   server-side, return `{ error: 'init_failed' }`.

Lower severity (consolidation): constant-time `secretEquals` duplicated x3
(`cron.ts:22`, `sc-webhook.ts:74`, `beehiiv.ts:335`); `EMAIL_RE`/`escapeHtml`
duplicated across boundaries → move to `shared/`.

**Confirmed done right** (no action): Stripe webhook raw-body signature verify +
idempotency ledger + per-customer serialization; server-side admin gate via
`requireAdminRequest` on every `/api/admin/*`; uniformly parameterized SQL; PKCE
BFF login; closed open-redirect (`safeReturnTo`); 32-byte HS256 key floor.

---

## Phase 0 — Tooling

Add `knip` (dev dep + `knip` script). `tsc` catches unused locals only, not unused
exports/files. Known dead code to delete once green: `src/lib/useAsyncResource.ts`
(+test), `server/entitlement.ts:212-218` `syncCircleAccess`,
`server/lib/activation.ts:80,380-387` back-compat shim, duplicate `redactEmail`,
`server/routes/stripe.ts:116-121` pass-through, commented ThemeToggle
(`PublicMasthead.tsx:805-849`, ~55 lines).

## Phase 1 — Bugs + security consolidations ✅ DONE

All landed; full suite green (727 pass, 0 fail); tsc + eslint clean.
- **Coupon display** → `formatCouponDiscount` in `src/lib/currency.ts`; 4 sites
  (CheckoutModal, promos, cancellations, billing) now use `Intl` (was hardcoded `$`).
- **space-posts gate**: `/api/circle/space-posts` now gates ark-plus bodies on the
  circle axis (withholds body/bodyHtml from non-members) and serves gated content
  `private, no-store` (was `public, s-maxage=300` — a CDN-cache leak). +3 tests.
- **init-error leak** (`dev-api.ts`): returns generic `{error:'init_failed'}`.
- **identity drift**: `me.ts` feeds/setup now calls `resolveRequestIdentity`
  (was a 4th, differently-ordered inline ladder); −20 LOC, unused imports removed.
- **secretEquals** → `server/lib/timing-safe.ts`; cron + sc-webhook + beehiiv.
- **isValidEmail / escapeHtml** → `shared/validation.ts`; 5 sites.

Deferred to Phase 4: merging `getSessionEmail` into `resolveRequestIdentity`
(agrees on precedence already; a straight merge risks a session↔resolver import
cycle — do it by moving the resolver down into `session.ts`).

## Phase 2 — Test suite (~3,200 LOC, low risk, best ratio)

Into existing `server/test-utils.ts`:
- `createDevApiHarness` — fake `makeReq`/`makeRes`/`runHandler`/`buildHandler`
  (29/29/16/9 copies) → **~1,800 LOC**.
- Shared `Middleware`/`FakeRes` types (~160).
- `baseTestEnv(overrides)` with unique DATABASE_URL invariant (~140).
- `test-mocks/neon.ts` `createNeonMock()` (~150).
- `test-mocks/stripe.ts` `createStripeMock()` + `buildSubscription/Session` (~450).
- `installFetchMock({jwks,sc,beehiiv})` (~150).
- `test.each` for sibling cases + guard-test helper (~350).
- Prune framework-behavior/dup 400 tests LAST, per-test review (~100, Med-High risk).
Coverage held equal throughout.

## Phase 3 — Frontend DRY

### Admin CRUD consolidation ✅ DONE

Landed; tsc + eslint clean; full suite green (733 pass, 0 fail — unchanged from
baseline). Admin routes 2,710 → 2,412 LOC (−298); shared infra +252 across three
new files, so the raw net is modest (~−50) — the win is **de-duplication /
bug-surface**, not line count (a change to the load/save/delete/error contract or
the button/field styling is now one edit, not six).

- `useCrudResource<T,Form>` (`src/lib/useCrudResource.ts`) — owns the
  items/loading/listError/editingId/form/saving/formError state, `refresh`,
  `startNew`/`startEdit`, and `runSave`/`runRemove` lifecycle wrappers. Adopted by
  careers, faqs, announcements, promos, and retention offers (cancellations).
- `<AdminListPanel>` / `<AdminListRow>` / `<StatusPill>` / `<AdminBadge>` /
  `<AdminTag>` (`src/components/admin/AdminList.tsx`) — the loading/error/empty/list
  shell and row chrome. `AdminBadge`/`AdminTag` replaced the `Badge`/`Tag` copies
  duplicated across promos + cancellations.
- `adminPrimaryButton`/`adminSecondaryButton` added to `admin-styles.ts`; all six
  admin routes now import `adminField`/`adminFieldLabel`/the buttons (was inline
  class strings).
- `errMessage(err, fallback)` (`src/lib/errMessage.ts`) — replaces the
  `err instanceof Error ? err.message : "…"` idiom in the admin routes.

### Deferred — plan premises did not hold on inspection

Verified against the current tree; these items rest on stale/incorrect assumptions
and were **not** executed (would force bad abstractions or delete live code):

- **`useAsyncResource` is NOT dead.** Live importers: `LatestEpisodes`,
  `PricingComparison`, `PricingCards`, `ShowPage`, `CircleCommunity`. Deleting it
  breaks the build. (Phase 0 also lists it for deletion — same error.)
- **Commented-code deletion.** No commented `ThemeToggle` exists at
  `PublicMasthead.tsx:805-849` (that's the live `MemberMenu`). The only nearby
  commented block is an intentional "Sign up" CTA toggle (`:349-355`) — a product
  decision, not dead code; left in place.
- **`pollForCheckoutSession` / `pollUntilActivated`** are genuinely different
  (different endpoints, return shapes, status handling) and sit in **payment-
  critical** paths. The only shared part is a generic deadline/sleep loop (~15 LOC);
  not worth the blast radius. Left as-is.
- **`usePricing()` (3 copies)** are more divergent than described: `CheckoutModal`
  owns interactive currency selection (stateful, `?locale_hint=`), while
  `PricingCards` (strict per-tier validation) and `PricingComparison` (presence
  check only) type the same `/api/pricing` response with **different `TierAmounts`
  shapes**. Only the ~8-line fetch+currency/factor core is truly shared — a
  `fetchPricingSnapshot()` helper is defensible but ~net-zero LOC.
### Shared presentational primitives ✅ DONE

Verified duplication per-file (three parallel research passes), then extracted the
clean, low-risk cluster. tsc + eslint clean; suite green (741 pass, 0 fail).

- `<Spinner>` + `<LoadingRow>` (`src/components/Spinner.tsx`) — one spinner disc
  (size via `className`, ARIA left to caller); adopted by __root, AdminGuard,
  PublicMasthead, and both checkout modals. `LoadingRow` was a byte-identical
  11-line fn duplicated in CheckoutModal + GiftCheckoutModal.
- `<PlayGlyph>` (`src/components/PlayGlyph.tsx`) — byte-identical 10-line icon that
  lived in both LatestEpisodes and ShowPage.
- `<PriceSkeleton>` (`src/components/PriceSkeleton.tsx`) — the pulsing price
  placeholder; PricingCards, PricingComparison, CircleCommunity.
- `<BillingPeriodToggle>` (`src/components/BillingPeriodToggle.tsx`) — the
  roving-tabindex monthly/annual radiogroup + keyboard model, shared by PricingCards
  (with savings badge) and PricingComparison.
- `<EpisodeMeta>` (`src/components/EpisodeMeta.tsx`) — the "date · duration" line,
  3× in ShowPage (LatestEpisodes diverges — uses `<time>` + long date, left alone).
- `useCopyToClipboard` (`src/lib/useCopyToClipboard.ts`) — clipboard write + 2200ms
  `copied` flag; SetupFlow's `copyFeed` (keeps its analytics/markFeedsSetUp side
  effects via the `onSuccess` cb) + `CopyableUrl`. discuss-threads uses a flash
  system → left separate.
- `modalPrimaryCta`/`modalSecondaryCta` (`src/lib/modalCta.ts`) — the two payment
  modals' CTA strings, previously byte-identical copies at risk of drift.

Also fixed an unrelated a11y bug found during the audit: four newsletter CTAs
(`newsletters/index.tsx`, `newsletters/$post.tsx`) were missing
`focus-visible:outline-*` — no visible keyboard-focus ring — now added.

### Deferred — need visual/keyboard review, not mechanical

- **`<CheckIcon>`** — three divergent path families (viewBox 20/24/16). Family A
  (pricing) is an identical pair worth merging; **Family B has a real stroke
  inconsistency (SetupFlow `strokeWidth 2` vs FeedSetupHub `2.4`)** — unifying is a
  deliberate visual change. Not folded together mechanically.
- **`useFocusTrap`** — only ONE genuine reimplementation (PublicMasthead's mobile
  drawer duplicates `Modal.tsx`'s trap verbatim; the other 8 grep hits are different
  a11y patterns — listbox, radiogroup — or already reuse `<Modal>`). Extractable for
  correctness but MED-HIGH a11y risk (Modal restores focus to `document.activeElement`,
  the drawer to its menu button; needs keyboard testing on both).
- **Global `<CtaButton>`** — rejected. ~35 CTA sites split into three genuinely
  different button styles (invert-on-hover vs marketing-white-on-hover + animated
  arrow vs two outline variants); a unified `variant` prop would re-encode every
  difference. Only the narrow modal-CTA const extraction (done above) was safe.

## Phase 4 — Server DRY (~440 LOC)

- `defineRoute({method,handler})` wrapper: builds `json`, enforces method, 405
  (~120). `circleReadRoute(path,key,fn)` factory (~60). `withMember` Stripe guard
  (~30). Unified Beehiiv client + `resolveBeehiivPublicationId` (~35).
  `membershipIsLive` single copy + `MEMBERSHIP_COLS` (~15). `envKeyForSlug` +
  unify TTL caches on `makeTTLCache` (~25). `customerIdOf`/`tsToIso` helpers (~15).
- Split `server/routes/stripe.ts` (1,442) → `stripe/{helpers,routes,webhook}.ts`;
  extract `validatePwycAmount` (dup at `:344` and `:838`).
- One `errorResponse(res, err)` contract; stop returning config-presence strings.

---

## Sequencing notes

- Phase 0 before deletions. Phase 1 first (bug-surface payoff). Phase 2 next
  (biggest LOC, lowest risk, builds test infra the later phases lean on).
- Run `bun test` after every step; each phase is independently shippable.
- Do NOT merge the two tier sources (Simplecast authoritative vs app_metadata
  mirror) — only dedup their resolution *code*.
