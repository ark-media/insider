# PRD: Cancellation, Debundling & Win-Back Flows

## Self-Clarification

1. **Problem/Goal:** Today `billing.tsx` has a single linear cancel flow (offer → reason → confirm) with Ark+-only copy and a single once-ever coupon save offer. That does not fit our three-tier model (`ark-plus | circle | bundle`). We need a mission-first, tier-aware retention experience that (a) reminds subscribers their support funds independent Jewish media, (b) offers the right plan/price/flexibility save for their tier and billing cadence, (c) lets bundle subscribers *debundle* rather than fully cancel, and (d) preserves the subscriber's email + marketing consent for win-back. Why now: the tier redesign shipped, standalone Circle pricing exists in the catalog, and we want to reduce involuntary/emotional churn before launch.

2. **Core Functionality:** (1) A tier-aware decision tree at the cancel entry point that routes to one of five flows. (2) New save-offer types beyond a single coupon — plan switches (monthly→annual, annual→monthly), a bounded supporter-rate coupon, and a perpetual discount. (3) A win-back-safe teardown that stops hard-deleting membership on `subscription.deleted` and instead archives with retained consent.

3. **Scope/Boundaries:** This PRD covers the cancel/debundle *decision tree, offers, eligibility, and data retention*. It does NOT build the win-back email campaigns themselves (only the retained data + a canceled-reason/outcome record they will consume). It does NOT change checkout, PWYC, or the pricing pages. Final discount amounts are Ryan-gated and are treated as **configuration**, not hardcoded — tasks proceed with the offer *plumbing* and read amounts from Stripe coupons / config.

4. **Success Criteria:** Each of the five flows renders the shared mission header, presents the correct tier/cadence-specific offer, and completes the correct Stripe action (period-end cancel via `cancel-subscription`, or tier change via `change-tier`). Debundle confirmations display the new standalone price. Retention eligibility is enforced once per rolling 12 months. After a full cancel, the Neon row is retained in an archived state with email + marketing-consent intact. All verifiable in browser + Stripe test mode + DB inspection.

5. **Constraints:** Pre-launch, greenfield — no backward-compat/migration burden for existing users, but we DO add forward migrations for schema changes. Cancel stays period-end + reversible. A pending Stripe schedule must be released before any cancel/discount update (`releaseScheduleIfAny`). Prices/coupons resolve from Stripe by lookup key/metadata — never hardcode amounts. Use ternary (not `&&`) for conditional JSX.

---

## Introduction/Overview

Replace the single linear Ark+ cancel flow with a **tier-aware retention system** for `ark-plus`, `circle`, and `bundle` subscribers. Every flow opens with the same mission reminder — that a subscription is support for independent Jewish media, not just content access — then progresses thoughtfully: remind why it matters → show the value of the current plan → offer a cheaper or more flexible way to stay → allow a low-friction exit. Bundle subscribers can *debundle* (drop one product, keep the other at its standalone price) instead of leaving entirely. On final cancellation we retain the subscriber's email and marketing consent for future win-back campaigns.

## Goals

- Route every cancel/debundle intent through the correct one of **five flows** based on current tier + intent.
- Open **every** flow with an identical mission-driven reminder.
- Offer tier- and cadence-appropriate saves: annual upsell, $6/mo supporter rate, move-to-monthly flexibility (Ark+); affordability discount (Circle); bundle-value retention + 3-months-free (debundle).
- Enforce that any promotional save is redeemable **at most once per rolling 12 months** per subscriber.
- Make debundling a **tier change** (remaining product continues at standalone price), clearly showing the new price before finalizing.
- **Retain email + marketing consent** after cancellation/debundle, tagged with what/why/what-was-kept, for win-back.
- Keep all discount amounts **configuration-driven** so Ryan's pending decisions don't block implementation.

## The Five Flows (reference model)

Driven by two axes — current tier × intent:

| # | Entry condition | Flow | Terminal action |
|---|---|---|---|
| A | tier=`ark-plus`, cancel | Ark+ 2-step save | `cancel-subscription` (period-end) |
| B | tier=`circle`, cancel | Circle affordability save | `cancel-subscription` (period-end) |
| C | tier=`bundle`, remove Ark+ | Debundle → keep Circle | `change-tier` → `circle` |
| D | tier=`bundle`, remove Circle | Debundle → keep Ark+ | `change-tier` → `ark-plus` |
| E | tier=`bundle`, cancel everything | Bundle full cancel (keep-just-one save) | `cancel-subscription` (period-end) |

**Flow A (Ark+ cancel), 2-step save:**
1. Mission message.
2. Price/plan flexibility, branched by cadence:
   - **Monthly:** offer annual (show savings) → if declined, offer **$6/mo supporter rate for 12 months** (provisional, Ryan sign-off).
   - **Annual:** offer **move to monthly at the annual-effective rate (~$6.67/mo) in perpetuity**, framed as flexibility, not a further discount below annual (Decision #5).
3. Reason capture → confirm → period-end cancel.

**Flow B (Circle cancel):** brief mission reminder → affordability save (**$5/mo × 3 months**, Ryan-gated, possibly extended) → reason → confirm → period-end cancel.

**Flow C (Debundle, remove Ark+ keep Circle):** bundle-value popup (savings lost) → runs the **Flow A** Ark+ save (mission + cadence offer) → if still leaving, final confirm **displaying new standalone Circle price (~$8/mo)** → `change-tier` to `circle`.

**Flow D (Debundle, remove Circle keep Ark+):** bundle-value popup →
   - **Monthly Ark+:** simple "sorry to see you leave Circle" confirm → `change-tier` to `ark-plus`.
   - **Annual Ark+:** offer **3 months of Circle free** before removing (Ryan-gated) → if declined, confirm → `change-tier` to `ark-plus`.

**Flow E (Bundle full cancel):** mission → **"keep just one" save**: offer to debundle to either Ark+ or Circle alone (at its standalone price) before canceling both (Decision #4) → if declined, reason → confirm → period-end cancel of the whole bundle.

## Tasks

### T-001: Shared mission header component
**Description:** Extract a single reusable mission-reminder block shown at the top of every cancel/debundle flow step-zero.

**Acceptance Criteria:**
- [ ] New component (e.g. `src/routes/account/MissionReminder.tsx`) with the approved mission copy (support funds independent Jewish media; each subscriber makes Ark Media's work possible).
- [ ] Rendered as the first element in flows A–E.
- [ ] Copy sourced from a single constant (one place to edit).
- [ ] Quality checks pass.
- [ ] Verify in browser.

### T-002: Tier-aware cancel entry decision tree
**Description:** Replace the single "Cancel" entry in `billing.tsx` with tier-aware routing.

**Acceptance Criteria:**
- [ ] `ark-plus` → single "Cancel Ark+" action (Flow A).
- [ ] `circle` → single "Cancel Community" action (Flow B).
- [ ] `bundle` → presents three choices: Remove Ark+ (keep Community), Remove Community (keep Ark+), Cancel everything (Flows C/D/E).
- [ ] Selecting a path opens the correct flow with the mission header.
- [ ] `cancel_initiated` analytics fires with a `flow` discriminator (`A`–`E`).
- [ ] Quality checks pass.
- [ ] Verify in browser for all three tiers (use auth bridge per `reference_browser_test_auth_bridge`).

### T-003: Retention eligibility → rolling 12-month window (coupons only)
**Description:** Change *promotional coupon* eligibility from once-ever to once per rolling 12 months. Plan switches (annual↔monthly) are NOT rate-limited (Decision #6).

**Acceptance Criteria:**
- [ ] `hasAcceptedRetention` (server/lib/cancellation.ts) becomes a windowed check: an `accepted` **coupon** outcome within the last 12 months blocks a new promotional coupon offer; older acceptances do not.
- [ ] Plan-switch offers (annual/monthly) bypass this check entirely — always allowed.
- [ ] Migration adjusts/reads the accepted-survey timestamp; the once-ever partial unique index (migration 0003) is replaced/relaxed to allow >1 accept over time while still blocking within-window coupon repeats.
- [ ] Unit test: coupon accept at T → coupon blocked at T+11mo, eligible at T+13mo; plan switch allowed at any T.
- [ ] Quality checks pass.

### T-004: Save-offer type model (beyond single coupon)
**Description:** Generalize the save offer so a flow step can present a *plan switch* or a *coupon* (bounded or perpetual), not just one coupon.

**Acceptance Criteria:**
- [ ] `shared/retention.ts` DTO extended to describe offer kind: `annual_switch | monthly_switch | supporter_coupon | affordability_coupon | circle_free_months | perpetual_discount`.
- [ ] Server derives the eligible offer(s) for a given tier + cadence (new function in `server/lib/retention.ts`), amounts/coupons resolved from Stripe (never hardcoded).
- [ ] `perpetual_discount` supports a `duration: forever` coupon; bounded coupons carry `duration_in_months`.
- [ ] Quality checks pass.

### T-005: Flow A — Ark+ 2-step save (monthly & annual)
**Description:** Implement the Ark+ cancel flow with cadence branching.

**Acceptance Criteria:**
- [ ] Step 1 mission; Step 2 cadence offer.
- [ ] Monthly: annual-switch offer shows concrete savings vs month-to-month; on decline, supporter-rate coupon ($6/mo × 12mo, config-driven).
- [ ] Annual: monthly-switch at the annual-effective rate (~$6.67/mo) in perpetuity via a `duration: forever` coupon, framed as flexibility, not a discount below annual (Decision #5).
- [ ] Accept annual/monthly switch → calls `change-tier` (cadence change) + attaches the perpetual coupon where applicable; accept bounded coupon → attaches coupon + clears pending cancel.
- [ ] Decline all → reason → confirm → `cancel-subscription`.
- [ ] Promotional coupon offers suppressed if the T-003 12-month window blocks them; plan switches always offered (Decision #6).
- [ ] Analytics: offer shown/accepted/declined per offer kind.
- [ ] Quality checks pass. Verify in browser (both cadences, Stripe test mode).

### T-006: Flow B — Circle affordability save
**Description:** Implement standalone-Circle cancel flow.

**Acceptance Criteria:**
- [ ] Brief mission reminder → affordability offer ($5/mo × 3mo, config-driven, "make it easier to stay part of the community" framing).
- [ ] Accept → attaches coupon + clears pending cancel; decline → reason → confirm → `cancel-subscription`.
- [ ] Eligibility respects T-003.
- [ ] Quality checks pass. Verify in browser (Stripe test mode).

### T-007: Flow C — Debundle, remove Ark+ keep Circle
**Description:** Bundle → Circle debundle that runs the Ark+ save then reprices Circle.

**Acceptance Criteria:**
- [ ] Popup 1: combined-subscription value + savings lost by separating.
- [ ] Continue → runs Flow A Ark+ save (mission + cadence offer).
- [ ] Still leaving → final confirm displays new standalone Circle price fetched from Stripe (`circle_{cadence}` lookup key), not hardcoded.
- [ ] Confirm → `change-tier` to `circle` (period-end via schedule; entitlement lost).
- [ ] Circle access + billing continue at standalone rate after Ark+ lapses.
- [ ] Quality checks pass. Verify in browser + confirm Stripe schedule created.

### T-008: Flow D — Debundle, remove Circle keep Ark+
**Description:** Bundle → Ark+ debundle, cadence-dependent.

**Acceptance Criteria:**
- [ ] Popup 1: bundle value reminder.
- [ ] Monthly Ark+: straight "sorry to see you leave Community" confirm → `change-tier` to `ark-plus`.
- [ ] Annual Ark+: offer 3 months of Circle free (config-driven, Ryan-gated) before removal; accept extends Circle entitlement 3mo free, decline → confirm → `change-tier` to `ark-plus`.
- [ ] Quality checks pass. Verify in browser (both cadences).

### T-009: Flow E — Bundle full cancel ("keep just one" save)
**Description:** Full cancel for bundle subscribers, with a keep-just-one retention step (Decision #4).

**Acceptance Criteria:**
- [ ] Mission → "keep just one" step offering debundle to Ark+ alone OR Circle alone, each showing its standalone price.
- [ ] Accept either → routes into the corresponding debundle (`change-tier` to `ark-plus` or `circle`); decline both → reason → confirm → `cancel-subscription`.
- [ ] Reuses Flow C/D debundle plumbing and the T-011 price preview.
- [ ] Quality checks pass. Verify in browser.

### T-010: Win-back cancellation record (email + consent already in Beehiiv)
**Description:** Email + marketing consent already persist in the `beehiiv_subscription` table (keyed by email, independent of the membership row), so they survive membership deletion. This task's real job is ensuring a durable, tailorable **cancellation record** that win-back campaigns can join to Beehiiv — NOT keeping the membership row alive (Decision #8).

**Acceptance Criteria:**
- [ ] The cancellation record (`cancellation_survey` / `server/lib/cancellation.ts`) captures **email**, what was canceled (tier/product), reason, offer outcome, and **retained_product** (e.g. left Ark+, kept Circle; or full exit).
- [ ] This record persists independently of the membership row's deletion, and can be joined to `beehiiv_subscription` by email for campaign targeting.
- [ ] `subscription.deleted` webhook behavior for the membership row is unchanged (revokes entitlements; row may still be deleted — Beehiiv retains marketing contactability).
- [ ] No access leak: entitlement resolver still resolves a canceled/absent membership to `free`.
- [ ] Reactivate still works before period end.
- [ ] Quality checks pass. Verify: cancel in test mode → cancellation record has email + retained_product; Beehiiv row intact; entitlements revoked.

### T-011: Debundle price-preview endpoint/helper
**Description:** Provide the "new standalone price" shown in debundle confirmations.

**Acceptance Criteria:**
- [ ] Given current tier + target tier + cadence, returns the target standalone price from Stripe (reuses `resolveCatalogPrice`).
- [ ] Used by Flows C and D confirmation screens.
- [ ] Quality checks pass.

### T-012: Analytics + admin reporting for new flows
**Description:** Extend analytics/admin so churn/save outcomes are legible per flow.

**Acceptance Criteria:**
- [ ] Events carry `flow` (A–E), `offer_kind`, and `retained_product` where applicable.
- [ ] `src/routes/admin/cancellations.tsx` distinguishes full cancels vs debundles and shows retained-product.
- [ ] Quality checks pass. Verify in browser.

## Functional Requirements

- **FR-1:** Every flow (A–E) MUST render the identical mission reminder as its first screen.
- **FR-2:** The cancel entry MUST route by current tier: `ark-plus`→A, `circle`→B, `bundle`→ choice of C/D/E.
- **FR-3:** Flow A monthly subscribers MUST be offered the annual plan first (with explicit savings), then the $6/mo × 12-month supporter coupon on decline.
- **FR-4:** Flow A annual subscribers MUST be offered a switch to monthly at ~$6/mo in perpetuity, framed as flexibility, not a further discount.
- **FR-5:** Flow B MUST offer the Circle affordability discount ($5/mo × 3 months, configurable) with community-belonging framing.
- **FR-6:** Debundling (C/D) MUST use `change-tier`, keep the remaining product active at its standalone price, and MUST display the new standalone price before finalizing.
- **FR-7:** Flow C MUST run the full Flow A Ark+ save before allowing Ark+ removal.
- **FR-8:** Flow D MUST branch by Ark+ cadence; annual subscribers MUST be offered 3 months of Circle free before removal.
- **FR-9:** Any *promotional coupon* save offer MUST be redeemable at most once per rolling 12 months per subscriber. Plan switches (annual↔monthly) are NOT rate-limited.
- **FR-10:** All discount amounts and standalone prices MUST resolve from Stripe (coupons/lookup keys) — none hardcoded in app code.
- **FR-11:** On cancellation, the system MUST persist a cancellation record (email, what/why, retained-product) that survives membership teardown and can be joined to `beehiiv_subscription` for win-back — without granting any access.
- **FR-12:** Cancellation MUST remain period-end and reversible via reactivate until the period lapses; a pending schedule MUST be released before cancel/discount updates.

## Non-Goals (Out of Scope)

- Building the win-back email campaigns / sequences themselves (only the retained data + records they consume).
- Changes to checkout, PWYC, pricing pages, or the pricing comparison table.
- Immediate (non-period-end) cancellation.
- New currencies or changes to currency presentment.
- Automatic/AI-driven offer personalization beyond the tier/cadence rules above.
- Finalizing the exact discount amounts (Ryan-owned; see Decisions & Remaining Sign-offs) — the build ships the plumbing with config.

## Technical Considerations

- **Reuse:** `change-tier` already does period-end downgrades via Stripe schedules and immediate prorated upgrades — debundle and cadence-switch ride on it. `cancel-subscription`, `retention-offer`, `accept-retention-offer` exist. Catalog already has Circle standalone at $8/mo and bundle at $13.
- **Schedule hygiene:** `releaseScheduleIfAny` must precede any cancel/coupon update or Stripe rejects it.
- **Perpetual discount:** the annual→monthly perpetual offer needs a `duration: forever` coupon — a new coupon shape vs today's bounded, once-burned retention coupon. Priced at the annual-effective rate (~$6.67/mo) per Decision #5, so it is not a discount below annual.
- **Win-back:** email + marketing consent already live in `beehiiv_subscription` (keyed by email, independent of the membership row) and survive `subscription.deleted`. T-010 therefore only needs a durable cancellation *record* joinable by email — it does NOT need to keep the membership row alive. Resolver still resolves canceled/absent membership to `free` (no access leak).
- **Number reconciliation:** annual Ark+ = $80/yr = **$6.67/mo**. The annual→monthly perpetual offer uses $6.67 (Decision #5). The monthly supporter coupon ($6 × 12mo) remains provisional pending Ryan and may be reconciled to the same figure.

## Success Metrics

- 100% of cancel/debundle sessions render the mission header (analytics).
- Save-offer acceptance (retention) and debundle-instead-of-cancel rates are measurable per flow.
- Zero access leaks: canceled/archived rows never resolve to a paid entitlement (test + audit).
- Retention promo redeemed at most once per 12 months per subscriber (enforced + tested).
- Post-cancel rows retain email + marketing consent for eligible subscribers (DB audit).

## Decisions & Remaining Sign-offs

**Resolved (2026-07-21):**
4. **Flow E save** — offer "keep just one" (debundle to either Ark+ or Circle alone) before full cancel. → T-009.
5. **Perpetual rate** — annual→monthly perpetual switch is priced at the **annual-effective rate (~$6.67/mo)** via a `duration: forever` coupon; framed as flexibility, no discount below annual. → T-005.
6. **Eligibility scope** — the once-per-12-months limit applies to promotional **coupons only**; plan switches are always allowed. → T-003.
7. **Standalone Circle price** — confirmed **$8/mo** (per `scripts/stripe-catalog.ts`). No change needed.
8. **Marketing consent source** — email + newsletter/marketing consent live in `beehiiv_subscription` (keyed by email, independent of membership) and already survive teardown; GDPR opt-in handled at newsletter signup. T-010 narrowed to the cancellation *record*. → T-010.

**Provisional — pending Ryan sign-off** (build proceeds with these as config-driven placeholders; amounts swap via Stripe coupons):
1. **Ark+ monthly supporter rate** — $6/mo × 12 months. Reconcile against annual $6.67/mo (Ryan may prefer matching annual-effective).
2. **Circle affordability discount** — $5/mo × 3 months; possible extension of the discounted period.
3. **Annual Ark+ debundle** — 3 months of Circle free.
