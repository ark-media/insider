# Community 18+ Age Gate — Task Breakdown

**Goal:** Require a buyer to confirm they are 18 or older **before they can enter card details** for any purchase that grants community access, and record that confirmation durably so a misrepresentation is demonstrably on the buyer.

## Current state (baseline)

- Community access is the **`circle` entitlement axis**, held by tiers `circle` and `bundle`. It is resolved from Neon and enforced server-side in `callerHasCircleAccess` (`server/routes/circle.ts:29`). Ark+ does **not** carry it.
- There are four routes to acquiring that axis:
  | Path | Entry point |
  |---|---|
  | New standalone/bundled purchase | `POST /api/stripe/create-checkout-session` (`routes.ts:102`) |
  | Existing Ark+ member upgrading | `POST /api/stripe/change-tier` (`routes.ts:858`) |
  | Community/Bundle gift purchase | `POST /api/gift/create-checkout` |
  | Gift redemption | `POST /api/gift/redeem`, `/api/gift/claim` |
- Checkout runs `ui_mode: 'elements'` — our own UI, not Stripe-hosted.
- `subscription_data.metadata` already carries `tier`, `plan`, `amount_cents`, `currency` and the attribution bag, and the webhook reads them straight back off the subscription. **14 of Stripe's 50-key cap used.**
- `CheckoutModal` already runs a `Step` state machine (`CheckoutModal.tsx:64`) whose first step (`email`) precedes payment, and it is chosen synchronously from a build-time value rather than from an effect.
- ToS consent is already collected Stripe-natively via `consent_collection: { terms_of_service: 'required' }` + `TermsElement` (`CheckoutTerms.tsx`).

**Consequence: the gate is a new pre-payment step plus a server-side refusal; the record rides existing metadata plumbing. No migration.**

## Decisions

- **D1 — Stripe metadata, not a database table (RESOLVED).** The attestation lives at `subscription_data.metadata`, not in Neon. Stripe retains cancelled Subscription objects indefinitely, so the record survives churn; `change-tier` spreads `...sub.metadata`, so it survives an upgrade. This reuses a proven pattern in this codebase rather than introducing a new store.
  - *Considered and rejected:* an append-only `age_attestation` table. Stronger as evidence (Stripe metadata is freely editable by anyone with Dashboard access, with only the activity log behind it), but not worth a new table and migration for the subscription funnel. Accepted as a deliberate trade-down.
- **D2 — Key and value (RESOLVED).** `confirmed_age_18`. **Stripe stringifies all metadata values** — it reads back as the string `"true"`, never a boolean, so every read must compare against `'true'`.
- **D3 — Written only when the purchase grants `circle` (RESOLVED).** An Ark+ subscription carries no key at all. Absence = never attested.
- **D4 — Never written as `"false"` (RESOLVED).** The server refuses the request instead, so an unattested community purchase cannot exist. This — not the checkbox itself — is what makes the record load-bearing: there is no code path to a `circle` entitlement that skipped the gate.
- **D5 — Gate on axis acquisition, not per transaction (RESOLVED).** Required whenever a member gains `circle` (`!prevEnt.circle && nextEnt.circle`). Not on renewal, not on a plan or PWYC change by someone who already holds it.
- **D6 — Server-side predicate is `deriveEntitlements(tier).circle`, not tier-name matching (RESOLVED).** A future tier that includes community is then gated automatically. The client, which has no entitlement module, uses a small shared helper.
- **D7 — Attestation, not verification. No date of birth (RESOLVED).** A DOB field is PII we would have to protect, invites a COPPA problem if an under-13 enters one, and is no more verifiable than a checkbox. The attestation is the point: liability transfers because the buyer asserted it.
- **D8 — Ark+ funnel is untouched (RESOLVED).** No 18+ requirement on audio/newsletter, and no friction added to the largest funnel.
- **D9 — Gifts: purchase half closed, redemption half still open (PARTIAL).** Superseded in part. The original reading — that Stripe metadata structurally cannot cover gifts — was too broad: it is true of *redemption* (which writes a membership row with `stripe_subscription_id` null) but not of *purchase*, which mints a PaymentIntent that Stripe retains indefinitely and that already carries a metadata bag.
  - **Done:** `POST /api/gift/create-checkout` refuses a `circle`/`bundle` gift without `age_confirmed`, and stamps `confirmed_age_18` onto `payment_intent_data.metadata`. The giver ticks it on the `/plus/gift` form, before the payment modal opens.
  - **Note what that record is.** The giver is attesting about a *third party*. D7's argument — liability moves because the buyer asserted it about themselves — does not transfer: a giver may simply not know, and cannot bind the recipient. This is a weaker record than the subscription one, deliberately worded differently (`AGE_STATEMENT_RECIPIENT`) so the two can't be conflated in an audit.
  - **Still open:** the recipient receives the `circle` axis at redemption having asserted nothing. Until `/api/gift/redeem` + `/api/gift/claim` gate too, D4's property — *no code path to a `circle` entitlement that skipped the gate* — does not hold for gifts. The claim path is the natural place (the recipient is present and about to be logged in), and the record would need a `membership` column, since there is no Stripe object on that side.
  - **Still out of scope:** comped / staff grants, which have no Stripe object at either end.
- **D10 — Discovery/enforcement policy is deliberately unspecified (OPEN).** This PRD records the attestation and nothing more. Whether Ark acts on knowledge that a specific member is under 18 is a policy question, not a schema question, and is not presupposed here.

---

## Phase 1 — Shared predicate

**T1.1** New `shared/age-gate.ts`, matching the `shared/retention.ts` / `shared/cancellation.ts` pattern (predicates imported by both sides):

```ts
export const AGE_METADATA_KEY = 'confirmed_age_18'
export const AGE_STATEMENT = '…'          // the exact attested sentence, one place
export function requiresAgeGate(tier: Tier): boolean   // circle | bundle
```

`AGE_STATEMENT` is single-sourced so the UI copy and any future record cannot drift apart.

---

## Phase 2 — `create-checkout-session` (`routes.ts:102`)

**T2.1** Add `age_confirmed?: boolean` to the `readJson` body type (`routes.ts:105`).

**T2.2** Enforce after tier coercion (`routes.ts:150`) and **before the rate limiter consumes a token**, matching the existing "validate before rate-limit" ordering at `routes.ts:135` so a malformed request does not burn a legitimate retry's token:

```ts
if (deriveEntitlements(tier).circle && body.age_confirmed !== true) {
  return json(400, { error: '…', code: 'age_confirmation_required' })
}
```

**T2.3** Stamp into `subscription_data.metadata` (`routes.ts:264`), conditionally, so Ark+ subscriptions stay clean:

```ts
...(deriveEntitlements(tier).circle ? { [AGE_METADATA_KEY]: 'true' } : {})
```

---

## Phase 3 — `change-tier` (`routes.ts:858`)

The Ark+ → Bundle upgrade grants `circle` without ever touching the gated checkout.

**T3.1** Add `age_confirmed?: boolean` to the body type; enforce using the values the handler already computes at `routes.ts:947`:

```ts
if (!prevEnt.circle && nextEnt.circle && body.age_confirmed !== true) → 400
```

**T3.2 — Immediate branch.** Add the key to the `metadata` object at `routes.ts:1017`, which already spreads `...sub.metadata`.

**T3.3 — Period-end branch.** The scheduled phase is a separate write. **The stamp must land on the subscription, not only on the phase**, or an upgrade that lands at period end leaves no record. *Easiest thing in this PRD to miss.*

---

## Phase 4 — Modal step (`CheckoutModal.tsx`)

**T4.1** Add `| { kind: "age-gate" }` to `Step` (`:64`).

**T4.2** Make the initial step conditional (`:200`): `requiresAgeGate(tier) ? { kind: "age-gate" } : { kind: "email" }`. Synchronous off the `tier` prop, preserving the existing "decide the initial step synchronously rather than from an effect" property.

**T4.3** New render branch before the `email` branch (`:440`): `AGE_STATEMENT`, an explicit confirm action, and a decline affordance. Confirm → `setStep({ kind: "email" })`. Unticked, never pre-selected — a pre-ticked box is worth nothing as evidence.

**T4.4** Keep it visually and structurally separate from `CheckoutTerms` (Stripe's `TermsElement`) so the two consents cannot be argued to have been bundled.

**T4.5** Thread `age_confirmed` into the `create-checkout-session` POST body (`:338`–`:356`).

**T4.6 — Decline path.** On `bundle`, offer to continue as Ark+ rather than dead-ending (a real product, minus the community). On standalone `circle`, close with an explanation.

**T4.7 — Audit the callers.** `CheckoutModal` defaults `tier = "ark-plus"` (`:187`), so a community entry point that omits the prop **silently skips the gate**. Check `PricingCards`, `PricingComparison`, `EntitlementAccess`, and `routes/plus/gift.tsx`.

**T4.8** Analytics via the typed layer in `src/lib/analytics.ts`: `age_gate_viewed` / `age_gate_confirmed` / `age_gate_declined`, so the drop-off this adds is measurable.

---

## Phase 5 — Tests

**T5.1 `checkout-create-session.test.ts`** — extends the existing `stripeCalls` harness, which already asserts on `subscription_data`:
- circle/bundle without the flag → 400 `age_confirmation_required`
- with it → session created, metadata carries `confirmed_age_18: 'true'`
- ark-plus without it → succeeds, and the key is **absent**
- the 400 does not consume a rate-limit token

**T5.2 `change-tier.test.ts`**
- ark-plus → bundle without the flag → 400
- with it → stamped (immediate branch)
- **period-end branch stamps the subscription too** (T3.3)
- bundle → bundle plan/PWYC change → not gated

**T5.3 `CheckoutModal.test.tsx`**
- initial step is `age-gate` for circle/bundle, `email` for ark-plus
- confirm advances to `email`
- the POST body carries `age_confirmed`

---

## Verification before deploy

Real test-mode purchase of Bundle, then confirm in the Stripe Dashboard that the subscription shows `confirmed_age_18 = true`. **Run this on the upgrade path specifically** — that one is a metadata merge rather than a fresh write, and the period-end variant is a third distinct write.
