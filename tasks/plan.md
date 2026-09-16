# Plan — Cancellation Retention Survey + Discount Offer

## Goal
When an Ark+ member clicks **Cancel my membership**, walk them through a save flow
inside the existing Modal: **Offer → Reason → Confirm**. Capture why they're leaving,
make one discount-based save attempt, and only schedule the cancellation if they
still want out.

## Decisions (from interview)
| Topic | Decision |
|---|---|
| Step order | **Offer → Reason → Confirm** (multi-step stepper in existing `Modal`) |
| Offer audience | Same offer for everyone (not tailored to reason) |
| Offer source | Stripe coupon flagged `metadata.retention_offer=true` — admin-configurable; percent/amount/duration live on the coupon |
| Eligibility | Offered **once per member, ever**; eligibility burns **only on accept**. Decliners stay "unused". |
| No-offer fallback | If ineligible OR no retention coupon configured → skip Offer step; flow is **Reason → Confirm**. They never see that an offer existed. |
| On accept | Attach coupon to existing subscription (`discounts`), **also clear any pending `cancel_at_period_end`** (safety net), stay on same plan, show confirmation (discount + next billing date). |
| Reason input | **Required** single-select from fixed list + **optional** free-text note. |
| Reason storage | New Neon table `cancellation_survey`; surfaced in `/admin`. |

### Reason options (final — from reference screenshot)
Reason step copy: heading **"We're sorry to see you go"**, sub **"Help us improve by letting
us know why you're cancelling:"**. Store the slug, render the label.

| Slug | Label |
|---|---|
| `too_expensive` | Too expensive |
| `dont_listen_enough` | I don't listen enough |
| `technical_issues` | I could not access the content or had technical issues |
| `unhappy_with_content` | I am not happy with the content |
| `benefits_too_limited` | The subscriber benefits are too limited |
| `listened_to_target_episodes` | I listened to the specific episodes I signed up for |

Plus the optional free-text note (per earlier decision; the reference screenshot doesn't
show one, but it's additive). Reason single-select required.

## Current state (grounding)
- UI: `src/routes/account/billing.tsx` — "Cancel my membership" button opens a simple
  confirm `Modal` (`Yes, cancel` / `Never mind`) → `cancelSubscription()` in `src/lib/auth.ts`.
- API: `server/routes/stripe.ts` `POST /api/stripe/cancel-subscription` (lines ~234-272) —
  finds the active sub across the email's customers, sets `cancel_at_period_end: true`,
  returns `{ ok, access_until }`.
- Promos: `server/lib/stripe-promos.ts` ranks coupons for **checkout only**. There is **no**
  existing path to apply a coupon to an active subscription — that's net-new.
- DB: raw SQL migrations in `migrations/` (`NNNN_name.sql`), runner `scripts/migrate.ts`
  (`bun run migrate`, `migrate:create`, `migrate:status`). Next file is `0002_...`.
- API arch: Vite SPA + serverless; route modules under `server/routes/*.ts` exporting
  `Route[]`, registered in `server/dev-api.ts` / `api/handler.ts`; deps `{ env, stripe, appBaseUrl, activator }`.
- Reusable: accessible `Modal` (`src/components/Modal.tsx`), `Toast`, admin gating pattern
  (Auth0 role claim) already used by `/admin` endpoints.

## Architecture / new surface
**Backend**
- `server/lib/retention.ts` — pure helper `isRetentionCoupon(coupon)` (mirrors `isAutoApply`,
  keyed on `metadata.retention_offer`) + `pickRetentionCoupon(coupons)`.
- `GET /api/stripe/retention-offer` — auth'd; returns
  `{ eligible: boolean, offer: { couponId, label, percentOff, amountOff, durationMonths } | null }`.
  Eligible = has active sub **AND** a valid retention coupon exists **AND** no prior
  `cancellation_survey` row for this email with `offer_outcome='accepted'`.
- `POST /api/stripe/accept-retention-offer` — auth'd; finds active sub, applies coupon and
  clears any pending cancel in one update:
  `stripe.subscriptions.update(sub.id, { discounts: [{ coupon }], cancel_at_period_end: false })`,
  inserts `cancellation_survey(email, reason=null, note=null, offer_outcome='accepted', coupon_id)`,
  returns `{ ok, percentOff/amountOff, durationMonths, next_charge_at }`.
- Extend `POST /api/stripe/cancel-subscription` — accept body `{ reason, note, offer_outcome }`
  (`offer_outcome ∈ {'declined','not_offered'}`); validate `reason` present; insert survey row;
  then existing `cancel_at_period_end` behavior. Reason is required server-side, not just client.
- `GET /api/admin/cancellations` — admin-gated; aggregate counts by reason + recent rows.

**Frontend** (`src/routes/account/billing.tsx`, `src/lib/auth.ts`)
- New `CancelFlowModal` (or inline step state in billing.tsx) driving steps via discriminated
  union: `offer | reason | confirm | applying | done-cancelled | done-saved | error`.
- On "Cancel my membership": fetch `/api/stripe/retention-offer`; if `eligible` start at
  **offer**, else start at **reason**.
- Offer step: "Keep my discount" → `accept-retention-offer` → `done-saved`; "No thanks" → reason.
- Reason step: required radio + optional note; "Continue" → confirm.
- Confirm step: "Cancel membership" → `cancel-subscription` with `{reason, note, offer_outcome}`
  → `done-cancelled`; "Back" returns to reason.
- New `src/lib/auth.ts` helpers: `getRetentionOffer()`, `acceptRetentionOffer()`, and extend
  `cancelSubscription(reason, note, offerOutcome)`.

**DB** — `migrations/0002_cancellation_survey.sql` (use `bun run migrate:create`):
```sql
create table cancellation_survey (
  id           bigint generated always as identity primary key,
  email        text not null,
  reason       text,                       -- null when offer_outcome='accepted'
  note         text,
  offer_outcome text not null,             -- 'accepted' | 'declined' | 'not_offered'
  coupon_id    text,                        -- set when accepted
  created_at   timestamptz not null default now()
);
create index on cancellation_survey (email);
create index on cancellation_survey (offer_outcome);
```

## Dependency graph
```
0002 migration ─┬─► cancel-subscription survey write ─► Reason→Confirm stepper   (Task 1)
                │
                ├─► retention-offer + accept endpoints ─► Offer step + accept     (Task 2, needs Task 1's reason step)
                │
                └─► GET /api/admin/cancellations ─► admin reasons view            (Task 3, parallel to Task 2)
```
Task 1 is the foundation. Task 2 depends on Task 1. Task 3 depends only on the
migration (can run parallel to Task 2).

## Vertical slices

### Task 1 — Survey persistence + Reason→Confirm stepper (no-offer path)
Delivers the survey end-to-end for members who aren't offered a discount.
- Migration `0002_cancellation_survey.sql`; `bun run migrate` locally.
- Extend `cancel-subscription` to read `{reason, note, offer_outcome}`, validate `reason`,
  insert a row (`offer_outcome='not_offered'` for this task), then cancel.
- Replace the simple confirm modal with a 2-step stepper (Reason → Confirm). Reason required,
  optional note. "Back" navigates between steps.
- `cancelSubscription()` signature extended in `src/lib/auth.ts`.

**Acceptance criteria**
- Clicking Cancel shows step 1 (reason, "1 of 2"); cannot continue without selecting a reason.
- Confirming cancels (`cancel_at_period_end: true`) exactly as today and shows the existing
  "Access continues until …" success state.
- A row is written to `cancellation_survey` with the chosen reason/note and `not_offered`.
- Modal a11y preserved (focus trap, labelledBy, Esc/backdrop).

**Verification**
- `bun run migrate:status` shows 0002 applied; `select * from cancellation_survey` after a test cancel.
- Manual browser run via existing auth bridge; confirm Stripe sub has `cancel_at_period_end=true`.
- Unit test for the reason-required server validation.

---
### CHECKPOINT A — review Task 1
Survey path works and persists before any discount logic. Confirm table shape and reason list
with stakeholder before building the offer.

---
### Task 2 — Retention offer step (display + accept + decline)
Adds the full Offer path on top of Task 1.
- `server/lib/retention.ts` helpers + unit tests (mirror `stripe-promos.test.ts`).
- `GET /api/stripe/retention-offer` (eligibility) and `POST /api/stripe/accept-retention-offer`
  (apply coupon, write `accepted` row, return confirmation).
- billing.tsx: fetch offer on open; prepend Offer step when eligible ("Offer → Reason → Confirm",
  "1 of 3"). "Keep my discount" → applying → `done-saved` confirmation. "No thanks" → reason.
- When the member later declines+confirms, `cancel-subscription` is called with
  `offer_outcome='declined'`.

**Acceptance criteria**
- An eligible member (active sub + valid `retention_offer` coupon + no prior accepted row) sees
  the Offer step first; ineligible/no-coupon members skip straight to Reason (Task 1 behavior).
- Accepting attaches the coupon to the live subscription (visible in Stripe), writes an
  `accepted` row, shows discount + next-charge confirmation, and does **not** schedule cancel.
- After accepting once, a later cancel attempt by the same email skips the Offer step.
- Declining records `offer_outcome='declined'` on the eventual cancel.

**Verification**
- Unit tests: `isRetentionCoupon` / `pickRetentionCoupon`; eligibility = false when prior
  accepted row exists.
- Manual: with a test repeating coupon, accept → Stripe subscription shows the discount; re-enter
  flow → no offer. Decline path still cancels.

---
### CHECKPOINT B — review Task 2
Confirm Stripe coupon setup (a real `metadata.retention_offer=true` repeating coupon exists in
the target Stripe account) and that the apply-to-subscription call behaves on live Stripe.

---
### Task 3 — Admin cancellation-reasons view  (parallel to Task 2 after migration)
- `GET /api/admin/cancellations` (admin role-gated like existing admin routes): reason counts +
  recent rows (email, reason, note, outcome, date).
- `/admin` UI section: aggregate table + recent list.

**Acceptance criteria**
- Endpoint returns 401/403 for non-admins; admins see aggregates + recent rows.
- Reasons captured in Tasks 1/2 appear; accepted saves are distinguishable from cancels.

**Verification**
- Manual admin login; counts match `select reason, count(*) ... group by reason`.
- Non-admin request rejected.

---
### CHECKPOINT C — final review / ship
Five-axis review + a11y pass on the stepper, then ship.

## Risks / open items
1. **Pending-cancel + accept — RESOLVED:** `accept-retention-offer` clears
   `cancel_at_period_end: false` alongside applying the coupon, so a member who had already
   scheduled a cancellation and then accepts the discount is fully reinstated (no access cut at
   period end). Verification for Task 2 must cover this case (schedule cancel → accept → confirm
   `cancel_at_period_end=false` in Stripe).
2. **Coupon currency / type:** `amount_off` coupons must be USD (per existing pricing notes);
   prefer a `percent_off` repeating coupon for the offer. Validate in `pickRetentionCoupon`.
3. **Eligibility keyed by email:** consistent with the rest of the app, but a member with
   multiple Stripe customers is still one email — fine. Note: email-based, not customer-based.
4. **Reason required server-side:** enforce in `cancel-subscription`, not just the client.
5. **Tier mirror unaffected:** Simplecast remains source of truth for entitlement; this flow
   only touches Stripe subscription + the new survey table. No `app_metadata` changes.
6. **Idempotency:** double-clicks on accept could re-apply; the `discounts` set is idempotent in
   effect, but guard the survey insert (don't write duplicate `accepted` rows — upsert/guard on
   existing accepted row).
