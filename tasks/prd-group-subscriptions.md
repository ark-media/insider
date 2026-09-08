# Group Subscriptions — Task Breakdown

**Goal:** Let an institution buy a **block of annual Bundle seats** upfront at volume pricing, then enroll named members over time. Each member gets **one year of Bundle from the moment they claim**, after which access expires and they convert to self-pay.

## Current state (baseline)

- No group/institutional SKU exists. Everything is either a self-serve subscription (`ark_plus` / `circle` / `bundle`, monthly + yearly) or a one-time gift (`gift_<tier>_<term>`).
- **Gifts already do 90% of what a group seat needs:** `gift` table keyed on an opaque `redemption_token`, single-email magic link → `POST /api/gift/claim` → `findOrCreateAuth0User` → server-side login → `redeemGiftForRecipient` → per-axis expiry on `membership`.
- Per-axis expiries (`ark_plus_gift_expires_at`, `circle_gift_expires_at`, migration 0015) already model "a non-subscription term that the reconciler must not downgrade early."
- `gift-expiry-reminders.ts` + `gift_expiry_reminder_sends` (0016) already send pre-expiry email on a cron.
- Admin surface exists (`/api/admin/*`, Auth0 role claim) and `server/lib/csv.ts` handles CSV with formula-injection neutralisation.

**Consequence: a claimed group seat is entitlement-identical to a redeemed Bundle gift.** This PRD is mostly purchase + roster + provisioning on top of existing plumbing.

## Decisions

- **D1 — Seat grant (RESOLVED).** One seat = **annual Bundle**: both `ark_plus` and `circle` axes, 365 days from **claim**, not from purchase. Sets both `ark_plus_gift_expires_at` and `circle_gift_expires_at` to `claimed_at + 1yr`.
- **D2 — Pricing (RESOLVED).** Volume tiering, USD, per seat per year:
  | Seats | Price/seat | Block total |
  |-------|-----------|-------------|
  | 4–50   | $75 | $300 – $3,750 |
  | 51–99  | $70 | $3,570 – $6,930 |
  | 100+   | $65 | $6,500+ |
  Volume (not graduated): the whole quantity bills at the band its total lands in.
- **D3 — Band cliffs (RESOLVED, accept + surface).** Volume tiering means 51 seats ($3,570) costs **$180 less** than 50 ($3,750), and 100 seats ($6,500) costs **$430 less** than 99 ($6,930). Accepted deliberately. The seat picker must surface it as an upsell at the boundaries — *"Add 1 more seat and pay $430 less"* — rather than let a buyer land on the wrong side silently.
- **D4 — Enrollment (RESOLVED, phased).** **Phase 1:** Ark admin uploads a CSV of `name,email` against a block in `/admin`; cadence is biweekly per the institution agreement. **Phase 2 (deferred, not in this PRD's critical path):** institution self-serve portal at `/account/group/:blockId` — same tables, immediate activation, removes Ark from the loop.
- **D5 — No Stripe subscription.** The block is a **one-time payment**, not a per-seat subscription. Stripe per-seat assumes one shared billing cycle, one shared renewal, proration on quantity change, and institution-level auto-renewal — all four contradict D1 (per-seat clock from claim) and the spec (no institutional renewal; additional seats = a new, independently priced block).
- **D6 — No `billing_scheme: 'tiered'` price.** Stripe tiered pricing is documented only for recurring prices (every API example requires `recurring[interval]`), and a `mode: 'payment'` Session cannot take a recurring price. Compute the band **server-side** and pass inline `price_data` with `quantity: seats` — the same pattern already used for PWYC. The server is the sole authority on the band; a client-supplied `unit_amount` is never trusted.
- **D7 — Two purchase paths.** ≤50 seats → self-serve Checkout (card/ACH). ≥51 seats → **Stripe Invoice** (`collection_method: 'send_invoice'`, `days_until_due: 30`, PO number as a custom field). Institutions cannot put $6,500 on a card, and the invoice path is also the only one that handles tax exemption (schools, churches, nonprofits) properly.
- **D8 — Currency: USD only.** The subscription and gift catalogs carry 40 `currency_options`; group blocks do not. Non-USD institutions go through the invoice path.
- **D9 — Credit branch disabled (CORRECTNESS, load-bearing).** `redeemGiftForRecipient` credits an already-subscribed recipient's Stripe customer balance instead of stacking (the bundle-subset case, prd-gift-tiers D5). **A group seat must never take that branch** — the institution paid, so crediting the member converts institutional money into a personal account balance. Group seats take extend-the-axis only; if there is nothing to extend, the seat is still consumed.
- **D10 — Enrollment window (OPEN).** Unused seats expire 1yr after purchase, and a seat claimed on day 364 runs to day 729 — a two-year tail on a one-year sale. *Recommend:* cap enrollment at **90 days** from purchase, or accept the tail explicitly in the institution agreement. Decide before launch; it changes `group_block.enroll_by`.
- **D11 — Member already has a paid sub (OPEN).** *Recommend:* extend both axes by 365 days, seat consumed, nothing returned to the pool — simplest and matches gift extend-first semantics. Alternative is reject-and-return-seat, which needs a per-seat "bounced" state and an admin notification.
- **D12 — Member leaves the institution mid-year (OPEN).** *Recommend:* access continues to `expires_at`, no revocation, stated in the institution agreement. Revocable seats need a revoke path through SC + Circle and an appeal surface.
- **D13 — Refunds (OPEN).** *Recommend:* refunding a block voids **unclaimed** seats only; claimed seats keep their term (access already delivered, SC/Circle already provisioned). Full clawback needs an axis-revocation path that doesn't exist today.
- **D14 — Small-block abuse (OPEN).** At $75/seat against $250 list, a 4-seat block ($300) is the cheapest route to Bundle for any four people — undercutting four Bundle gifts ($520) and four subscriptions ($1,000). *Recommend:* require manual approval for blocks under some threshold, or route 4–50 through a request form rather than pure self-serve. Not a pricing change; a gating decision.
- **D15 — Conversion offer.** At expiry the member faces $75-subsidised → $250 self-pay, a 3.3x step. The pre-expiry email must offer the **step-down** (Ark+ $80 or Community $190) alongside full Bundle, reusing the existing `debundle_intro` coupon machinery. This is the revenue thesis of the feature and deserves more design attention than the purchase page.
- **D16 — Institution reporting: aggregate only.** The block admin sees counts (invited / claimed / expiring / converted), never per-member names or conversion status. Members did not consent to their employer seeing their subscription behaviour.

---

## Phase 1 — Schema

**T1.1** Migration `0019_group_blocks.sql` — two tables.

```sql
create table group_block (
  id                       text primary key,
  institution_name         text not null,
  billing_email            text not null,
  tier                     text not null default 'bundle',
  seats_total              integer not null,
  unit_amount_cents        integer not null,   -- band price actually charged
  currency                 text not null default 'usd',
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  admin_sub                text,               -- Auth0 sub of the seat admin (Phase 2)
  purchased_at             timestamptz not null default now(),
  enroll_by                timestamptz not null,
  status                   text not null,      -- pending|active|exhausted|expired|void
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table group_seat (
  id           text primary key,
  block_id     text not null references group_block(id),
  email        text not null,
  name         text,
  claim_token  text unique,        -- opaque, same shape as gift.redemption_token
  status       text not null,      -- invited|claimed|expired|revoked
  invited_at   timestamptz,
  claimed_at   timestamptz,
  expires_at   timestamptz,        -- claimed_at + 365d
  redeemed_by  text,               -- recipient Auth0 sub
  created_at   timestamptz not null default now()
);

create unique index group_seat_block_email_idx on group_seat (block_id, lower(email));
create index group_seat_block_status_idx on group_seat (block_id, status);
create index group_block_pi_idx on group_block (stripe_payment_intent_id);
```

- **Acceptance:** migration applies clean on `ark-insider-dev`; the unique index rejects the same email twice in one block (the biweekly-batch duplicate case) while allowing the same person across two different institutions.

**T1.2** `server/lib/group.ts` — row access mirroring `membership.ts`: `getBlockById`, `getBlockByPaymentIntent`, `insertBlock`, `getSeatByClaimToken`, `insertSeats` (batch), `markSeatClaimed` (atomic, same CAS pattern as `markGiftRedeemed`), `seatCountsForBlock`.
- **Acceptance:** `markSeatClaimed` returns false on a second call for the same token; unit-tested without a live DB the way `membership` helpers are.

## Phase 2 — Pricing + purchase

**T2.1** `server/lib/group-pricing.ts` — `perSeatCents(seats)` returning the D2 band, plus `blockTotalCents(seats)`, plus `cliffHint(seats)` returning `{ suggestSeats, savingCents } | null` for D3.
- Bands live in code, not Stripe, since D6 rules out a tiered Price object.
- Minimum 4 seats enforced here, not just in the UI.
- **Acceptance:** unit tests for every boundary (3 rejects, 4/50/51/99/100/101), and `cliffHint(50)` → `{ suggestSeats: 51, savingCents: 18000 }`, `cliffHint(99)` → `{ suggestSeats: 100, savingCents: 43000 }`.

**T2.2** Stripe catalog — add one product `group_bundle_annual` to `scripts/stripe-catalog.ts`. **No Price object** (D6: amount is inline `price_data` at Session/Invoice creation). Product metadata: `catalog_key`, `entitlements: 'ark_plus,circle'`, `kind: 'group'`.
- **Acceptance:** script provisions the product idempotently; no price with a `group_` lookup key is created.

**T2.3** `POST /api/group/create-checkout` — self-serve path (≤50 seats).
- Body: `institution_name`, `billing_email`, `billing_name`, `seats`.
- Rate-limited on email+IP **and** IP alone, exactly as `giftRoutes` does (unauthenticated endpoint that provisions Stripe objects).
- `mode: 'payment'`, `line_items: [{ price_data: { currency: 'usd', product: GROUP_PRODUCT_ID, unit_amount: perSeatCents(seats) }, quantity: seats }]`.
- `payment_intent_data.metadata`: `group_block: '1'`, `seats`, `tier: 'bundle'`, `institution_name`, `billing_email`, `unit_amount_cents`.
- **Acceptance:** a request claiming 4 seats with a forged `unit_amount` of 6500 is charged $75/seat; seats > 50 is rejected with a pointer to the invoice path.

**T2.4** `POST /api/admin/group/invoice` — admin-created invoice for ≥51 seats.
- Creates/reuses a Stripe Customer for the institution, adds an invoice item with the computed `unit_amount` × `quantity`, `collection_method: 'send_invoice'`, `days_until_due: 30`, PO number in `custom_fields`, same metadata as T2.3.
- **Acceptance:** invoice finalises and sends; metadata round-trips to the webhook.

**T2.5** Webhook branches in `server/routes/stripe/webhook.ts`.
- Extend the existing `payment_intent.succeeded` handler with a `group_block` branch (it already branches on `gift_token`) → insert `group_block` with `status: 'active'`, `enroll_by` per D10.
- Add `invoice.paid` for the T2.4 path.
- Idempotent on `stripe_payment_intent_id` / `stripe_invoice_id`, matching the existing gift-activation discipline.
- **Acceptance:** replaying the same event twice creates one block; `stripe trigger` covers both paths.

## Phase 3 — Enrollment (Ark admin CSV)

**T3.1** `POST /api/admin/group/:blockId/seats` — accepts parsed `{ name, email }[]`, validates against remaining seats and `enroll_by`, inserts `group_seat` rows with fresh `claim_token`s, returns a per-row result (`invited` / `duplicate` / `rejected`).
- Over-allocation is rejected atomically, not partially applied.
- **Acceptance:** uploading 30 names to a 25-seat block enrolls 0 and reports the shortfall; re-uploading a batch containing 5 already-invited emails enrolls only the new ones.

**T3.2** Admin UI — block list, block detail (seat ledger: total / invited / claimed / remaining / expiring), CSV upload with a **dry-run preview** before commit, resend-invite, revoke-unclaimed.
- **Acceptance:** the preview shows exactly what T3.1 would do without writing anything.

**T3.3** Invite email (Resend) + send queue. One email per seat: *"[Institution] has given you a year of Ark+ and the Ark Community."* Single magic link carrying a gift-claim-shaped token (`signGiftClaimToken` equivalent scoped to `group_seat`).
- Batched with backoff; a send failure leaves the seat `invited` and re-sendable, never silently dropped.
- **Acceptance:** a 100-seat batch sends without tripping Resend limits; a mid-batch failure is retryable without double-sending.

## Phase 4 — Claim + provisioning

**T4.1** `POST /api/group/claim` — mirrors `/api/gift/claim`: verify token → `findOrCreateAuth0User(email, name, { email_verified: true })` → grant → atomic `markSeatClaimed` → session cookies → welcome page. Grant-before-claim ordering, same as the gift path (a lost race is harmless because grants are idempotent; a throw must not burn the seat).
- **Acceptance:** clicking the link twice grants once; a revoked or expired seat mints no session.

**T4.2** Group-seat grant path — sets **both** `ark_plus_gift_expires_at` and `circle_gift_expires_at` to `now + 365d` (extending, not replacing, any later existing value), provisions the SC feed and the Circle member.
- **D9 enforced here:** the credit branch is unreachable for group seats. Add an explicit test that an active Bundle subscriber claiming a group seat receives **extended axes and zero Stripe customer balance change**.
- **Acceptance:** unit tests for all four recipient states — no membership, free, single-axis sub, active Bundle sub.

**T4.3** Circle provisioning at batch scale. 100 seats = 100 Circle member creates via `CIRCLE_API_TOKEN` (v1) on top of 100 SC grants. Needs concurrency limiting, per-seat failure isolation, and a retry surface in admin.
- This is genuinely new load: gifts arrive one at a time, group claims can arrive in bursts after a batch send.
- **Acceptance:** a simulated 100-claim burst provisions all 100 with no dropped Circle members; an injected Circle 5xx leaves that one seat retryable and the other 99 complete.

## Phase 5 — Expiry + conversion

**T5.1** Extend `gift-expiry-reminders.ts` (and `gift_expiry_reminder_sends`) to cover `group_seat.expires_at` — 30-day and 7-day emails.
- **Acceptance:** cron picks up group seats alongside gift terms; no double-send.

**T5.2** Conversion landing page — *"your sponsored year is ending"* with three prefilled options per D15: Bundle $250, Ark+ $80, Community $190, with the `debundle_intro` coupon applied where it applies. Analytics events on view / choice / completion via the existing typed event layer.
- **Acceptance:** each CTA opens checkout at the right tier with the coupon attached where eligible; events land in PostHog.

**T5.3** Reconciler safety — confirm `loadAllMemberships` / the keep-set logic treats a group-seat axis expiry identically to a gift expiry (it should already, since it reads the same columns) and never downgrades a claimed seat early.
- **Acceptance:** a reconciler dry-run against a seeded block leaves all claimed seats in the keep-set.

## Phase 6 — Marketing surface

**T6.1** `/groups` landing page: band table, seat calculator wired to `perSeatCents` + `cliffHint`, two CTAs (buy ≤50 / request invoice ≥51), FAQ covering the D10–D13 answers.

**T6.2** Nav + `/pricing` cross-link, per the existing Subscribe IA.

---

## Deferred (Phase 2 of D4, not scoped here)

Institution self-serve portal at `/account/group/:blockId` — same tables, block admin authenticated via `group_block.admin_sub`, immediate seat activation, aggregate-only reporting per D16. Removes the shared spreadsheet and the biweekly batch entirely. Everything in Phases 1–5 is built so this is a read/write layer on the same schema, not a rewrite.
