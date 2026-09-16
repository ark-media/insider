# Ark Plus — Membership Lifecycle QA Testing Plan

**Scope:** Subscription creation, cancellation, reactivation, and cross-system
synchronization (Beehiiv, Auth0, Circle, Neon DB).
**Format:** Manual QA checklist — human-runnable Given/When/Then cases.
**Target environment:** Staging / Vercel preview + **Stripe test mode**.
**Failure coverage:** Exhaustive — every fan-out leg × every failure mode, plus
idempotency, ordering, and reconciliation recovery.

> This plan is grounded in the actual code paths (see `server/routes/stripe.ts`,
> `server/entitlement.ts`, `server/routes/me.ts`, `server/lib/beehiiv-sync.ts`).
> When an endpoint or behavior changes, update this doc alongside the code.

---

## 1. System model — what "in sync" means

The Stripe webhook is the **write source of truth**. A single subscription state
change fans out to four systems. The **Neon `membership` row is read-authoritative**
for `/api/me` — a live row keyed on the caller's Auth0 sub decides the tier,
regardless of a stale JWT claim. Auth0 `app_metadata.tier` is a **mirror**.

| System | Role | What holds the state | How to inspect |
|---|---|---|---|
| **Stripe** | Source of truth | Subscription `status`, `cancel_at_period_end`, `cancel_at` | Stripe Dashboard (test mode) → Customers / Subscriptions |
| **Beehiiv** | Newsletter delivery | Subscription + premium tier on Ark Daily (free) & Members Letter (paid) | Beehiiv dashboard; `beehiiv_subscription` DB mirror |
| **Auth0** | Claim mirror | `app_metadata.tier` = `ark-plus-member` \| `free`; `gift_expires_at` | Auth0 Dashboard → User → app_metadata |
| **Circle** | Access to the Fold | Membership in subscriber access group | Circle admin → access group members |
| **Neon DB** | Read-authoritative for `/api/me`; ledger + mirror | `stripe_webhook_events`, `beehiiv_subscription`, `cancellation_survey` | `bun run` SQL / Neon console (`ark-insider-dev`) |

### 1.1 The sync invariant (truth table)

For a given email, these are the **expected** states per system. Every sync test
asserts the full row, not just one cell.

| User state | Stripe | Beehiiv tier | Auth0 `tier` | Circle | `/api/me` |
|---|---|---|---|---|---|
| **Never subscribed** | none | none (or free if logged in once) | `free` (or absent) | not in group | `free` |
| **Active paid** | `active`, `cancel_at_period_end=false` | premium on Members Letter + Ark Daily | `ark-plus-member` | in group | `ark-plus-member` |
| **Cancelled (pending, pre-period-end)** | `active`, `cancel_at_period_end=true`, `cancel_at` set | **still premium** until period end | **still** `ark-plus-member` | **still** in group | `ark-plus-member` |
| **Reactivated** | `active`, `cancel_at_period_end=false` | premium | `ark-plus-member` | in group | `ark-plus-member` |
| **Expired / deleted** | `canceled` (or `paused`) | downgraded to free | `free` | removed from group | `free` |
| **Gift active** | n/a (payment_intent) | premium | `ark-plus-member` + `gift_expires_at` | in group | `ark-plus-member` |
| **Payment failed (past_due)** | `past_due` | premium (until deleted) | `ark-plus-member` (until deleted) | in group | `ark-plus-member` |

> **Key timing nuance:** cancellation does **not** revoke access. Entitlement is
> only torn down on `customer.subscription.deleted`/`paused` at period end.
> Every cancel test must confirm access *persists* until then.

---

## 2. Test environment & tooling setup

Complete these once before running any suite. **Do not run against production.**

### 2.1 Preconditions checklist

- [ ] Staging/preview deployment URL confirmed and reachable.
- [ ] Stripe is in **test mode**; preview uses `STRIPE_SECRET_KEY` (test) +
      matching `STRIPE_WEBHOOK_SECRET` for the preview endpoint.
- [ ] Stripe webhook endpoint for the preview URL exists and is **enabled**
      (Stripe Dashboard → Developers → Webhooks). Note its signing secret.
- [ ] `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` point at **test-mode** prices.
- [ ] Auth0 tenant is the staging tenant; Management M2M client has
      `update:users_app_metadata`; Login Action (post-login tier claim) is deployed.
- [ ] Beehiiv test publication IDs + premium tier ID set; Beehiiv webhook secret set.
- [ ] Circle `CIRCLE_API_TOKEN` + `CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID` point at a
      test/sandbox community (or a disposable access group).
- [ ] Neon branch for the preview is migrated (`bun run migrate`); you have read
      access to query `stripe_webhook_events`, `beehiiv_subscription`,
      `cancellation_survey`.
- [ ] `CRON_SECRET` known, so you can manually trigger
      `POST /api/cron/reconcile-entitlements`.

### 2.2 Test data hygiene

- Use plus-aliased emails per test, e.g. `qa+sub-create-01@yourdomain.com`, so each
  case has a clean slate across all five systems and is easy to grep/clean up.
- Stripe test cards:
  - `4242 4242 4242 4242` — succeeds.
  - `4000 0000 0000 9995` — declined (insufficient funds).
  - `4000 0000 0000 0341` — attaches but fails on charge (first payment fails).
  - `4000 0027 6000 3184` — requires 3DS authentication.
  - For Adaptive Pricing currency tests, use Stripe's test billing-country override.
- After each case, record the email + Stripe customer/subscription IDs in the run log.

### 2.3 Webhook control (critical for the failure matrix)

- **Replay / resend:** Stripe Dashboard → Webhooks → event → "Resend". Used to test
  idempotency and recovery after a leg fails.
- **Out-of-order:** Resend an earlier event after a later one to simulate reordering.
- **Local option (only if testing localhost):** `stripe listen --forward-to
  localhost:<port>/api/stripe/webhook` and swap in the printed signing secret.
  Note: localhost is **not** in the deployed delivery path by default.
- **Simulating a leg failure:** see §6.1 for techniques (revoke a downstream
  credential, point a leg at an invalid ID, or use a network block) so the webhook
  partially fails and you can verify recovery.

### 2.4 Per-system inspection cheat-sheet

Record this evidence for every sync assertion:

- **Stripe:** subscription object — `status`, `cancel_at_period_end`, `cancel_at`,
  `current_period_end`.
- **Beehiiv:** subscriber tier on both publications; cross-check `beehiiv_subscription`
  DB row (`status`, tier).
- **Auth0:** user `app_metadata.tier`, `app_metadata.gift_expires_at`.
- **Circle:** access-group membership present/absent.
- **DB:** `stripe_webhook_events` row for the event id (idempotency ledger);
  `cancellation_survey` for cancel reason.
- **App:** `GET /api/me` response `tier` + feeds (the user-facing truth).

---

## 3. Suite A — Subscription creation

Endpoint: `POST /api/stripe/create-checkout-session` → Stripe Checkout (Adaptive
Pricing + automatic tax). Activation happens via webhook
`customer.subscription.created` → `activateScSubscriptionForStripeSub()`.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **SUB-01** | Monthly happy path | Given a new email; When checkout with `plan=monthly` + card `4242`; Then payment succeeds, user redirected to `/?checkout=complete`, and `/api/me` returns `ark-plus-member`. | Full "Active paid" row of §1.1: Stripe `active`; live `membership` row, tier `ark-plus`; Beehiiv premium on both pubs; Auth0 `ark-plus-member`; Circle in group; ledger row present. |
| **SUB-02** | Yearly happy path | Same as SUB-01 with `plan=yearly`. | Same. Confirm price = `STRIPE_PRICE_YEARLY`. |
| **SUB-03** | Custom amount | When checkout with a custom (pay-what-you-want) amount; Then session created at that amount and activates normally. | Same "Active paid" row; verify amount on the Stripe subscription. |
| **SUB-04** | Auto-applied promo coupon | Given an active Stripe coupon; When checkout; Then best active coupon auto-applied (`listActiveCoupons()`); discounted amount charged. | Same; verify discount on invoice. |
| **SUB-05** | Adaptive Pricing currency | Given a non-USD billing country (test override); When checkout; Then localized currency shown and charged. | Stripe subscription currency matches; Neon/Beehiiv/Auth0/Circle unaffected (still paid). |
| **SUB-06** | Welcome email + immediate login | When SUB-01 completes; Then welcome email sent and post-checkout token (`/api/auth/checkout-session`) logs the user in immediately. | `/api/me` returns paid using the checkout token *before* the next full login. |
| **SUB-07** | Rate limit | When >5 checkout-session creates for one email within an hour; Then 6th is rate-limited (HTTP 429), no Stripe session created. | No new Stripe customer/subscription; no ledger churn. |
| **SUB-08** | Declined card | When checkout with `4000…9995`; Then payment declined, **no** subscription created, **no** activation. | All five systems remain in "Never subscribed"; `/api/me` = `free`. |
| **SUB-09** | 3DS challenge | When checkout with `4000 0027 6000 3184`; Then 3DS prompt appears; on success activates, on abandon does not. | Success → "Active paid" row; abandon → "Never subscribed". |
| **SUB-10** | Duplicate email already subscribed | Given an already-active paid email; When they start checkout again; Then no duplicate active subscription is silently created (verify intended behavior — block or reuse customer). | No second subscription / no double Beehiiv premium; document actual behavior. |
| **SUB-11** | Invalid input | When `plan` missing/invalid or email malformed; Then 400 with validation error, nothing created. | No side effects in any system. |

---

## 4. Suite B — Cancellation

Endpoint: `POST /api/stripe/cancel-subscription` (auth required). Cancels at
**period end** (`cancel_at_period_end=true`); stores a cancellation survey.
Nothing is mirrored upstream: Beehiiv's premium tier has no cancel schedule of its own.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **CXL-01** | Cancel at period end | Given an active paid, logged-in user; When they cancel with a reason; Then Stripe sets `cancel_at_period_end=true` + `cancel_at`; response shows access-until date. | "Cancelled (pending)" row: `membership.cancel_at` set, row still live; **Beehiiv still premium**; **Auth0 still `ark-plus-member`**; **still in Circle**; `/api/me` still `ark-plus-member`. |
| **CXL-02** | Survey persisted | When CXL-01; Then `cancellation_survey` row stored with `reason` + optional `note`. | DB row matches submitted reason/note; `offerOutcome` recorded if a retention offer was shown. |
| **CXL-03** | Access persists until period end | After CXL-01, before `current_period_end`; Then `/api/me` still returns paid and gated content/Circle still work. | Entire "Cancelled (pending)" row holds; no teardown yet. |
| **CXL-04** | Period-end teardown | When `current_period_end` passes (or simulate via Stripe test clock / resend `customer.subscription.deleted`); Then entitlement torn down. | "Expired / deleted" row: `membership` row no longer live; Beehiiv downgraded to free; Auth0 `free`; removed from Circle; `/api/me` = `free`. |
| **CXL-05** | Retention offer accepted | When the retention offer is accepted at cancel time; Then cancellation does **not** proceed (or a discount applied) per `retention.ts`. | Subscription stays "Active paid"; `cancellation_survey` reflects accepted offer; offer idempotent (no double-apply). |
| **CXL-06** | Cancel without auth | When unauthenticated POST to cancel; Then 401, no Stripe change. | No state change anywhere. |
| **CXL-07** | Cancel a non-existent/already-cancelled sub | When the email has no active sub or is already pending-cancel; Then graceful error / idempotent no-op. | No duplicate survey rows; no Stripe churn. |
| **CXL-08** | Cancel with invalid reason | When reason missing/invalid; Then 400, nothing cancelled. | No side effects. |

---

## 5. Suite C — Reactivation

Endpoint: `POST /api/stripe/reactivate-subscription` (auth required). Clears
`cancel_at_period_end`. Nothing to sync back upstream — the Beehiiv tier never changed.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **RACT-01** | Reactivate pending-cancel | Given a paid user who cancelled (CXL-01) and is still before period end; When they reactivate; Then Stripe `cancel_at_period_end=false`, `cancel_at` cleared; response shows next renewal date. | "Reactivated" row: `membership.cancel_at` cleared; Beehiiv premium; Auth0 `ark-plus-member`; in Circle; `/api/me` = `ark-plus-member`. |
| **RACT-02** | Reactivate after full expiry | Given a user whose sub already deleted at period end; When they hit reactivate; Then it fails gracefully (must re-subscribe via checkout, not reactivate). | No partial Beehiiv/Circle re-grant; user directed to checkout. |
| **RACT-03** | Cancel → reactivate → cancel | Rapid toggle within one period; Then final Stripe state matches the last action and all systems reflect it. | After last action, full truth-table row matches; `cancel_at` set and cleared correctly each time; no orphaned schedule. |
| **RACT-04** | Reactivate without auth | Unauthenticated POST; Then 401. | No state change. |
| **RACT-05** | Reactivate an active (non-cancelled) sub | When sub is already active with no pending cancel; Then idempotent no-op / clear message. | No state change; `/api/me` unchanged. |

---

## 6. Suite D — Exhaustive synchronization failure matrix

This is the core of the plan. The webhook fans out to five legs. Test **each leg
failing independently**, confirm the **other legs still succeed** (or the handler's
actual atomicity behavior), and confirm **recovery** via Stripe's automatic webhook
retry and/or the nightly reconciliation cron.

### 6.1 How to induce a single-leg failure

Pick whichever is cleanest in staging:

- **Beehiiv leg:** invalid `BEEHIIV_API_KEY` or bad publication/tier id.
- **Auth0 leg:** revoke `update:users_app_metadata` on the M2M client, or use an email
  with no Auth0 user.
- **Circle leg:** invalid `CIRCLE_API_TOKEN` or wrong access-group id.
- **DB leg:** point at an unreachable branch (ledger write fails).
- **Network:** block egress to one provider's host.

Restore the credential, then **resend the Stripe event** and/or run the reconcile
cron to verify the system self-heals.

### 6.2 Failure matrix — one row per leg

For each failing leg, run the matrix below at three trigger points:
**(a)** during `subscription.created`, **(b)** during cancel
`subscription.updated`, **(c)** during `subscription.deleted` at period end.

| ID | Failing leg | Failure mode | Expected immediate behavior | Expected recovery |
|---|---|---|---|---|
| **FAIL-BV-01** | Beehiiv | 5xx on premium upgrade | Newsletter premium not applied; document whether webhook fails (retry) or logs-and-continues. | Retry/reconcile applies premium; `beehiiv_subscription` mirror converges. |
| **FAIL-BV-02** | Beehiiv | 5xx on downgrade at teardown | User keeps premium newsletter after expiry (over-entitlement). | Reconcile downgrades; verify no indefinite premium leak. |
| **FAIL-AU-01** | Auth0 | mgmt API 5xx / scope revoked on set tier | `app_metadata.tier` not updated → JWT claim stale on next login. Confirm `/api/me` still relies on the **Neon row**, not the stale claim. | Retry/reconcile sets `tier`; new login embeds correct claim. |
| **FAIL-AU-02** | Auth0 | No Auth0 user for email at activation | Handler must not crash; tier write skipped/queued. | User provisioned on first login or by reconcile; tier then set. |
| **FAIL-CR-01** | Circle | 5xx on add-to-group | User paid everywhere but **no Circle access**. | Retry/reconcile Pass 3 adds member; access restored. |
| **FAIL-CR-02** | Circle | 404 on remove at teardown | Treated as desired state (already absent) — should be a no-op success, not a failure. | No retry needed; verify handler treats 404 as success. |
| **FAIL-CR-03** | Circle | 409/422 on add (already member) | Idempotent success, not an error. | No duplicate membership. |
| **FAIL-DB-01** | DB ledger | Insert to `stripe_webhook_events` fails | If ledger write is the dedup gate, a failed write may cause **reprocessing** on retry. Confirm downstream effects stay idempotent (no double Beehiiv premium). | On retry, event processed exactly-once in effect. |
| **FAIL-MULTI-01** | Two legs (e.g. Auth0 + Circle) | Both 5xx | Partial fan-out: Beehiiv succeeds, Auth0+Circle stale. | Reconcile cron heals both passes; final row converges. |

> For each FAIL case, **record the intermediate (drifted) state** of all four
> systems, then the **post-recovery** state. The drift window is the real risk —
> document how long a user can be in an inconsistent state and whether it is
> user-visible (e.g. paid in Stripe but locked out of Circle).

### 6.3 Recovery mechanisms to verify

- [ ] **Stripe automatic retry:** webhook returning non-2xx is retried with backoff —
      confirm a transient failure self-heals without manual action.
- [ ] **Manual resend:** Dashboard "Resend" converges a permanently-failed leg after
      the credential is fixed.
- [ ] **Nightly reconcile cron** (`POST /api/cron/reconcile-entitlements`):
  - Pass 1: active Stripe subs → ensures `ark-plus-member` (heals missed upgrades).
  - Pass 2: Auth0 `ark-plus-member` users not in active Stripe set → downgrade to
    `free` (respecting `gift_expires_at`).
  - Pass 3: Circle access-group members not entitled → removed.
  - [ ] Run it manually with a known drifted user and confirm convergence.
  - [ ] Confirm gift users (`gift_expires_at > now`) are **protected** from downgrade.
- [ ] **Auth required:** cron rejects requests without the correct `CRON_SECRET`
      (constant-time compare) — confirm 401 on bad/missing token.

---

## 7. Suite E — Idempotency & event ordering

| ID | Title | Given / When / Then | Pass criteria |
|---|---|---|---|
| **IDEM-01** | Replayed event | When the same `subscription.created` event is delivered twice (Resend); Then the second is deduped via `stripe_webhook_events`. | No second membership row; no double Beehiiv premium; single ledger row; `/api/me` unchanged. |
| **IDEM-02** | Replayed cancel | Resend `subscription.updated` (cancel) twice; Then the cancel is recorded once, idempotently. | `cancel_at` correct; no duplicate survey rows. |
| **ORDER-01** | Out-of-order updated-before-created | Deliver `subscription.updated` before `created`; Then handler tolerates / orders correctly. | No crash; final state matches Stripe; no orphaned partial entitlement. |
| **ORDER-02** | created → deleted rapid | Subscribe then immediately delete (test clock); Then teardown wins; no lingering entitlement. | Final "Expired/deleted" row; no residual Beehiiv/Circle access. |
| **ORDER-03** | deleted then late updated | Late `updated` arrives after `deleted`; Then it does **not** resurrect access. | User stays `free`. |
| **IDEM-03** | Concurrent webhook + reconcile | Run reconcile cron while a webhook for the same user is processing; Then no race corrupts state (batch size 8). | Final state consistent; no partial/torn writes. |

---

## 8. Suite F — `/api/me` authority & provisioning gaps

`/api/me` resolves session from Auth0 bearer → checkout token → `ark_session`
cookie, then uses the **Neon membership row as authoritative**.

| ID | Title | Given / When / Then | Pass criteria |
|---|---|---|---|
| **ME-01** | Live row overrides stale free claim | Given a live `membership` row but Auth0 claim says `free` (drift); When `/api/me`; Then returns `ark-plus-member`. | The row wins over a stale JWT. |
| **ME-02** | Stale paid claim, no row | Given JWT claims `ark-plus-member` but no live membership row; When `/api/me`; Then it does **not** grant paid (avoids spoofed/stale upgrade). | Returns `free` (not paid). |
| **ME-03** | First login auto free-subscribe | Given an Auth0-sourced login, no membership row, not claiming paid; When `/api/me`; Then idempotent free Beehiiv subscribe (`ensureFreeSubscription`). | One Ark Daily subscribe; repeated calls do not duplicate. |
| **ME-04** | Checkout-source provisioning gap | Given a checkout token but no membership row yet (activation lag); When `/api/me`; Then the by-email net resolves it via Stripe customer, or 401 — never a false paid. | Resolves to the real tier once the webhook writes the row. |
| **ME-05** | Session resolution order | Test each path (Auth0 bearer, checkout cookie/bearer, `ark_session` cookie) resolves the correct email. | Correct identity per source; no cross-user leakage. |

---

## 9. Suite G — Adjacent flows (regression guard)

Run these to ensure the membership changes didn't break neighbors.

| ID | Title | Pass criteria |
|---|---|---|
| **GIFT-01** | Gift purchase activates | `payment_intent.succeeded` with `metadata.kind=gift` → membership row + Auth0 `ark-plus-member` + `gift_expires_at` set; Beehiiv premium; Circle access. |
| **GIFT-02** | Gift expiry | After `gift_expires_at`, reconcile downgrades to `free` and removes Circle; before expiry, protected from downgrade. |
| **NL-01** | Newsletter toggle free on/off | `PUT /api/me/newsletters` `free=true` re-subscribes; `free=false` unsubscribes; mirror row matches Beehiiv. |
| **NL-02** | Newsletter premium toggle gated | `premium=true` requires active entitlement; a free user cannot self-grant premium. |
| **NL-03** | Beehiiv webhook mirror | Beehiiv `subscription.*` webhooks update `beehiiv_subscription` mirror (created/confirmed/upgraded/downgraded/paused/resumed/deleted). |
| **PAY-01** | `invoice.payment_failed` | Logged; subscription goes `past_due` but access not immediately revoked (until `deleted`). Confirm dunning behavior matches intent. |

---

## 10. Execution & reporting

- **Run order:** §2 setup → A → B → C → E (idem/order) → F (/api/me) → D (failure
  matrix) → G. Run D last per-user since it deliberately drifts state.
- **Per-case record:** test ID, email, Stripe IDs, the full §1.1 truth-table row
  observed (all five systems + `/api/me`), screenshots/API evidence, pass/fail, notes.
- **Drift log:** for every FAIL-* case, log the drift window (what was inconsistent,
  for how long, whether user-visible) and the recovery path that fixed it.
- **Exit criteria for launch:**
  - [ ] All happy-path A/B/C cases pass.
  - [ ] Every fan-out leg failure (D) recovers via retry **or** reconcile, with no
        permanent over- or under-entitlement.
  - [ ] Idempotency (IDEM-*) and ordering (ORDER-*) all pass.
  - [ ] `/api/me` never grants paid without a live membership row (ME-02, ME-04).
  - [ ] Reconcile cron is scheduled, auth-protected, and demonstrably heals drift.

---

## 11. Answered design questions (from the source)

These were resolved by reading `server/routes/stripe.ts` and
`server/entitlement.ts`. They set the expected results for the failure matrix.

1. **Webhook atomicity — mixed, by design.** Per-leg behavior, not all-or-nothing:
   - **The Beehiiv premium grant** (the paid product) is the **only hard-fail leg**: if it throws,
     the handler returns **500** and **deletes the idempotency claim**
     (`stripe.ts:677`) so Stripe's retry reprocesses. Recovery = Stripe retry.
   - **Auth0 + Circle** go through `Promise.allSettled` (`entitlement.ts:71`) — a
     failure returns status `'error'` but **never throws**, so the webhook returns
     **200**. Recovery = **nightly reconcile cron**, not Stripe retry.
   - **Auth0, Circle and the Beehiiv mirror writes** are **soft-fail** (try/catch
     + log) → 200.
   - `AlreadySubscribedError` → 200, **keeps** the claim (terminal; manual follow-up).
2. **Idempotency gate — claim-before-work, release-on-failure.** The
   `insert ... on conflict (id) do nothing returning id` runs **before** the fan-out
   (`stripe.ts:649`). 0 rows ⇒ `200 {deduped:true}`, skip. A **ledger insert error is
   non-fatal** — logs and processes anyway. A retryable dispatch failure **deletes**
   the claim so the retry isn't deduped.
3. **Duplicate active subscriptions (SUB-10):** guarded at *activation* via
   `AlreadySubscribedError` (→ 200 `skipped`), **not** blocked at checkout creation.
   ⚠️ **Risk:** a second checkout can create a second *Stripe* subscription (double
   billing) while the grant stays single. SUB-10 must assert no double Stripe billing.
4. **`past_due` access policy:** `invoice.payment_failed` only logs (`stripe.ts:767`);
   access is revoked **only** on `subscription.deleted`/`paused`. The retention window
   is governed by **Stripe dunning / Smart Retries config**, not code — set it
   intentionally and test PAY-01 against that config.
5. **Reconcile coverage limits:** Auth0 search caps at 1000 / 10 pages then falls back
   to the export job (already unit-tested). Circle drift removals cap at **100/run**
   (`CIRCLE_DRIFT_MAX_REMOVE`). The export fallback needs >1000 staging subscribers to
   exercise live → **out of scope** for launch QA; note the 100-cap as the realistic
   limit.

---

## 12. Automated coverage map (what's already tested vs. manual-only)

Several high-value cases are **already automated** in `bun test` — do not re-run them
manually except as launch smoke. Newly added in this effort are marked **[new]**.

| Plan case | Automated? | Test file |
|---|---|---|
| ME-01 (live row overrides stale free claim) | ✅ | `server/me.test.ts:312` |
| ME-02 (stale paid claim, no row → free) | ✅ | `server/me.test.ts:330` |
| ME-03 (first-login free auto-subscribe, idempotent) | ✅ | `server/me.test.ts:488,540` |
| ME-04 (checkout-cookie provisioning gap → 401) | ✅ | `server/me.test.ts:424` |
| FAIL-AU-01 / FAIL-CR-01 leg isolation (unit) | ✅ | `server/entitlement.test.ts:214,231` |
| Circle 404/409/422 idempotency | ✅ | `server/entitlement.test.ts:131,146,163,197` |
| Reconcile upgrade/downgrade/gift/drift recovery | ✅ | `server/entitlement.test.ts:459+` |
| Auth0 export-job fallback (1000-cap) | ✅ | `server/entitlement.test.ts:668` |
| **FAIL-AU/CR at webhook layer → not 500** | ✅ **[new]** | `server/stripe-webhook.test.ts` (resilience block) |
| **IDEM-01 dedup on replay** | ✅ **[new]** | `server/stripe-webhook-idempotency.test.ts` |
| **FAIL-DB-01 ledger error non-fatal** | ✅ **[new]** | `server/stripe-webhook-idempotency.test.ts` |
| End-to-end checkout → all-systems (real APIs) | ❌ manual | Suite A/E (staging) |
| Stripe dunning window / PAY-01 timing | ❌ manual | requires Stripe config + test clock |
| Circle/Beehiiv real-account propagation | ❌ manual | staging only |
| SUB-10 double-Stripe-subscription billing | ❌ manual | staging only |

**Manual focus:** the failure matrix's *recovery* legs against **real** Auth0 /
Circle / Beehiiv, dunning timing, and the double-billing risk (SUB-10) — none of
which a unit test can prove end-to-end.
