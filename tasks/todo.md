# TODO — Cancellation Retention Survey + Discount Offer

See `tasks/plan.md` for full context, acceptance criteria, and verification.

## Task 1 — Survey persistence + Reason→Confirm stepper (no-offer path)
- [x] Create `migrations/0002_cancellation_survey.sql` (`bun run migrate:create cancellation_survey`)
- [x] Run `bun run migrate`; verify with `bun run migrate:status` (applied; table shape verified in DB)
- [x] Extend `POST /api/stripe/cancel-subscription` to read+validate `{reason, note, offer_outcome}` and insert a survey row before cancelling (survey write is best-effort — never blocks the cancel)
- [x] Server unit test: reason-required validation (`server/cancel-subscription.test.ts`, 5 tests)
- [x] Extend `cancelSubscription()` in `src/lib/auth.ts` (options object: reason, note, offerOutcome)
- [x] Replace simple confirm modal in `billing.tsx` with 2-step stepper (Reason → Confirm); reason required, optional note, Back nav
- [x] Verify a11y (focus trap, labelledBy, Esc/backdrop) preserved — Modal component unchanged; `labelledBy`/`describedBy` still wired, step content lives inside the trap
- [ ] Manual: cancel writes a row + sets `cancel_at_period_end=true` — **pending live browser run (do at Checkpoint A)**

Shared reason list + outcome validators live in `shared/cancellation.ts`; survey SQL in `server/lib/cancellation.ts`.

### ▸ CHECKPOINT A — review table shape + reason list before discount logic

## Task 2 — Retention offer step (display + accept + decline)
- [x] `server/lib/retention.ts`: `isRetentionCoupon` + `pickRetentionCoupon` (+ `toRetentionOffer`); unit tests in `server/retention.test.ts`
- [x] `GET /api/stripe/retention-offer` (eligibility: active sub + valid coupon + no prior accepted row; uniform ineligible response, fails closed)
- [x] `POST /api/stripe/accept-retention-offer` (apply coupon via `discounts` + clear `cancel_at_period_end:false`, write `accepted` row, return confirmation; coupon re-derived server-side; guard duplicate accepted rows)
- [x] `getRetentionOffer()` + `acceptRetentionOffer()` in `src/lib/auth.ts`
- [x] `billing.tsx`: fetch offer on open; prepend Offer step when eligible (Offer → Reason → Confirm), dynamic step numbering
- [x] "Keep my discount" → applying → saved confirmation (discount + next charge date)
- [x] "No thanks" → reason step; eventual cancel sends `offer_outcome='declined'`
- [x] Endpoint tests: eligibility (sub/coupon presence) + accept applies coupon & clears cancel (`server/cancel-subscription.test.ts`)
- [ ] Manual: accept attaches discount in Stripe + skips offer on re-entry; decline still cancels — **pending live run (Checkpoint B)**
- [ ] Manual: schedule cancel → accept offer → verify `cancel_at_period_end=false` (safety net) — **pending live run (Checkpoint B)**

Refactor: extracted `findActiveSubscription()` (reused by cancel + both new endpoints). DTO in `shared/retention.ts`.

### ▸ CHECKPOINT B — confirm real Stripe `retention_offer` coupon exists in target account

## Task 3 — Admin cancellation-reasons view (parallel to Task 2 after migration)
- [x] `GET /api/admin/cancellations` (admin-gated): outcome + reason aggregates + recent rows (empty-safe without DB)
- [x] `/admin` UI section: new "Cancellations" tab + overview card + page (`src/routes/admin/cancellations.tsx`) — outcome stat cards, reasons table, recent responses table
- [x] Verify 403 for non-admins (`server/admin-cancellations.test.ts`); aggregation SQL verified against the live DB (counts match group-by; accepted rows excluded from byReason)

### ▸ CHECKPOINT C — five-axis review + a11y pass, then ship
