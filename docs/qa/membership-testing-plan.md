# Ark Plus — Membership Lifecycle QA Testing Plan

**Scope:** Buying, changing, cancelling, reactivating, gifting, refunding and
expiring a membership, and keeping Stripe, Neon, Beehiiv, Circle and Auth0 in
step while that happens.
**Format:** Manual QA checklist — human-runnable Given/When/Then cases.
**Target environment:** Vercel preview (or local `bun dev` + `stripe listen`) with
**Stripe test mode**.
**Last refreshed:** 2026-09-23, against `feat/spotify-follow-checklist`.

> Grounded in the code: `server/routes/stripe/routes.ts` (member-facing Stripe
> routes), `server/routes/stripe/webhook.ts` (event handling),
> `server/lib/activation.ts` (provisioning), `server/entitlement.ts` (axes,
> Circle sync, reconciler), `server/lib/entitlement-resolver.ts` + `server/routes/me.ts`
> (what the app reads), `server/routes/gift.ts`, `server/lib/beehiiv-sync.ts`,
> `server/lib/beehiiv-feeds.ts`. When one of these changes, update this doc with it.

---

## 1. System model — what "in sync" means

### 1.1 Tiers and axes

A membership is two independent **axes**. The tier is just the name for a
combination of them.

| Tier | `arkPlus` axis (Beehiiv premium → Members Letter + private podcast feeds) | `circle` axis (the Fold) |
|---|---|---|
| `ark-plus` | ✅ | — |
| `circle` | — | ✅ |
| `bundle` | ✅ | ✅ |
| `free` | — | — |

Each tier sells monthly or yearly, and every tier is pay-what-you-want above a
per-currency floor. The tier a subscription grants comes **only** from its Stripe
product's `metadata.entitlements` (`ark_plus`, `circle`); subscription metadata is
never trusted for it.

### 1.2 Who holds what

| System | Role | What holds the state | How to inspect |
|---|---|---|---|
| **Stripe** | Billing | Subscription `status`, `cancel_at_period_end`, `cancel_at`, attached schedule; provisioning markers in sub metadata (`beehiiv_premium`, `circle_provisioned`, `auth0_user_id`, `welcomed_axes`) | Dashboard (test mode) → Customers / Subscriptions |
| **Neon** | **The only authority** for what a member gets | `membership` row keyed on `auth0_sub`: `tier`, `status`, `cancel_at`, pending-change columns (`scheduled_tier`, `schedule_id`, `pending_*`), gift expiries (`ark_plus_gift_expires_at`, `circle_gift_expires_at`). **No row = free.** | Neon console / SQL |
| **Beehiiv** | Delivers the `arkPlus` axis | One publication. Free = Ark Daily; premium tier = Members Letter **and** the private feed for each premium show (Spotify / Apple / RSS) | Beehiiv dashboard → subscriber; `beehiiv_subscription.has_premium` mirror |
| **Circle** | Delivers the `circle` axis | Subscriber access group vs cancelled access group (`CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID` / `CIRCLE_CANCELLED_ACCESS_GROUP_ID`). Revoking **moves** the member; it never deletes them | Circle admin → access groups |
| **Auth0** | Login only | The account exists (DB connection + pre-linked `email` passwordless identity). **Holds no tier** — no claim, no `app_metadata` mirror | Auth0 Dashboard → Users |

Stripe webhooks write Neon and push the axes out to Beehiiv and Circle. `/api/me`
and the Fold login gate (`/api/internal/circle-access`) both read Neon, so a Neon
row that is right means the app shows the right thing, even if Beehiiv or Circle
has drifted.

### 1.3 When a row grants access

- Subscription status `active`, `trialing` or **`past_due`** grants. `unpaid`,
  `canceled` and everything else don't.
- A subscription also stops granting once `current_period_end` is more than
  **7 days** in the past, even if no webhook arrived.
- A row with no subscription and no gift is a **comp/staff row** and grants its
  tier forever.
- A gift axis grants while its expiry is in the future. It is ORed with the
  subscription's axes, so an Ark+ subscription plus a live Fold gift reads as
  `bundle`.

### 1.4 The sync invariant (truth table)

Every sync case asserts the whole row, not one cell. The Beehiiv and Circle
columns only apply to the axes the tier includes (§1.1). A `circle`-only member
should have **no** Beehiiv premium, and an `ark-plus`-only member should **not**
be in the Circle subscriber group.

| Member state | Stripe | Neon `membership` | Beehiiv premium | Circle | Auth0 | `/api/me` tier |
|---|---|---|---|---|---|---|
| **Never subscribed** | none | none | none, or free only | not in either group | none (or free login) | `free` |
| **Active paid** | `active`, no cancel | row, `status=active` | ✅ (arkPlus tiers) | subscriber group (circle tiers) | account exists | the tier |
| **Cancel pending** | `active`, `cancel_at_period_end=true` | row, `cancel_at` set | **still ✅** | **still subscriber** | unchanged | **still the tier** |
| **Change pending** (downgrade / debundle / cheaper plan) | `active` + schedule attached | row, `scheduled_tier` + `schedule_id` set | current tier's axes until the change lands | current tier's axes | unchanged | current tier |
| **Past due** | `past_due` | row, `status=past_due` | ✅ | subscriber | unchanged | the tier |
| **Ended** | `canceled` (or `paused`) | **row deleted** (or cleared down to a live gift) | downgraded to free (not unsubscribed) | moved to the cancelled group | **unchanged — never deleted** | `free` (or the gift's tier) |
| **Gift active** | none (or an extended sub, §7) | row with gift expiry | ✅ if gift includes arkPlus | subscriber if gift includes circle | account created at claim | the gift's tier |
| **Gift expired** | none | row deleted by the nightly reconcile | downgraded by the nightly reconcile | removed by the nightly reconcile once enforced (§8.4) | unchanged | `free` as soon as expiry passes |

> **Timing:** cancelling revokes nothing. Access ends on
> `customer.subscription.deleted` / `paused`, which Stripe sends at period end
> (or right away for an immediate cancel or a refund). Every cancel case must
> confirm access **persists** until then.

---

## 2. Test environment & tooling setup

Complete once before running any suite. **Never run against production.**

### 2.1 Preconditions checklist

- [ ] Target deployment URL confirmed and reachable; `APP_BASE_URL` matches it
      (login redirects and email links are built from it).
- [ ] **Know which Neon project the target's `DATABASE_URL` points at.** As of
      2026-09-17, local dev **and** the live ark-plus.xyz site both read
      `ark-insider-dev`, so QA rows sit next to real members. Use `qa+` aliases
      and clean up after yourself.
- [ ] Stripe is in **test mode**; `STRIPE_SECRET_KEY` (test) and a
      `STRIPE_WEBHOOK_SECRET` that matches the endpoint delivering to this URL.
- [ ] A test-mode webhook endpoint for this URL is **enabled** and subscribed to:
      `customer.subscription.created/updated/deleted/paused`,
      `payment_intent.succeeded`, `charge.refunded`, `charge.dispute.created`,
      `invoice.payment_failed`. Localhost isn't reachable from Stripe: use
      `stripe listen --forward-to localhost:<port>/api/stripe/webhook` and swap in
      the secret it prints.
- [ ] The test-mode catalog is loaded: prices with lookup keys
      `<ark_plus|circle|bundle>_<monthly|yearly>`, `currency_options` for the
      supported currencies, and `metadata.entitlements` on each product.
- [ ] Auth0: the Management client can create users and link identities; the
      post-login Action is deployed (signup gate + Fold gate).
- [ ] Beehiiv: `BEEHIIV_API_KEY`, `BEEHIIV_PUBLICATION_ID_ARK_DAILY`,
      `BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER`, `BEEHIIV_PREMIUM_TIER_ID`,
      `BEEHIIV_WEBHOOK_SECRET`, `BEEHIIV_SUBSCRIBER_HOST`. The Beehiiv webhook
      (`/api/beehiiv/webhook?key=…`) points at this URL if you're testing feed
      activation.
- [ ] Circle: `CIRCLE_ADMIN_API_TOKEN` (v2 admin) + `CIRCLE_API_TOKEN` (v1), subscriber and cancelled
      access-group ids, `CIRCLE_GATE_SECRET` (shared with the Auth0 Action).
- [ ] Resend key set, and you can read the `qa+` inbox.
- [ ] `CRON_SECRET` known, so you can call the crons by hand.
- [ ] For CXL-09 / FEED cases: a real Spotify account on a phone or desktop.

### 2.2 Test data hygiene

- One plus-aliased email per case, e.g. `qa+sub-01@yourdomain.com`, so every system
  starts clean and is easy to find and delete.
- Stripe test cards:
  - `4242 4242 4242 4242` — succeeds.
  - `4000 0000 0000 9995` — declined (insufficient funds).
  - `4000 0000 0000 0341` — attaches, then fails when charged (use for dunning).
  - `4000 0027 6000 3184` — requires 3DS.
- Record per case: email, Stripe customer / subscription / payment-intent ids,
  Auth0 user id.
- **Cleanup:** cancel the Stripe sub, delete the Neon `membership` row, the Auth0
  user, the Circle member and the Beehiiv subscriber for each `qa+` address.

### 2.3 Driving time and webhooks

- **Reaching period end:** Stripe test clocks only work on customers created on a
  clock, and our checkout doesn't create them that way. To simulate the end of a
  period, **cancel the subscription immediately** in the Dashboard (fires
  `customer.subscription.deleted`).
- **Gift expiry:** set `ark_plus_gift_expires_at` / `circle_gift_expires_at` on the
  row to a past time, then check `/api/me` and run the reconcile cron.
- **Replay:** Dashboard → Webhooks → event → **Resend**.
- **Out of order:** resend an older event after a newer one. The handler re-reads
  the live subscription from Stripe, so an old payload should never win.
- **Crons:** `curl -H "Authorization: Bearer $CRON_SECRET" <url>/api/cron/<name>`.
  They only run on schedule in production (`vercel.json`), so call them by hand
  in QA.

### 2.4 Per-system evidence to record

- **Stripe:** `status`, `cancel_at_period_end`, `cancel_at`, `current_period_end`,
  schedule id + phases, discounts, sub metadata markers.
- **Neon:** the `membership` row; `stripe_webhook_events` row for the event
  (`status` `processing`/`done`); `cancellation_survey`; `gift`;
  `beehiiv_subscription`; `beehiiv_feed_activations`.
- **Beehiiv:** subscriber status + tier.
- **Circle:** which access group the member is in.
- **Auth0:** user exists, identities (DB + `email`), `email_verified`.
- **App:** `GET /api/me` → `tier`, `axes`, `feeds`; the `/account` plan card.
- **Email:** subject + which link it carries.

---

## 3. Suite A — Buying a subscription

Flow: `/plus` or `/pricing` → CheckoutModal → `POST /api/stripe/create-checkout-session`
(embedded Checkout, `ui_mode: elements`) → consent checkboxes recorded via
`POST /api/stripe/record-consent` → pay → the page polls
`POST /api/auth/checkout-session` until the webhook has provisioned →
`customer.subscription.created` writes the Neon row.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **SUB-01** | Ark+ monthly | Given a new email; When checkout `tier=ark-plus`, monthly, card `4242`, both boxes ticked; Then paid, signed in on return, `/api/me` = `ark-plus`, welcome email arrives. | "Active paid": Neon row `ark-plus`; Beehiiv premium; **not** in Circle; Auth0 user with DB + `email` identities; sub metadata `beehiiv_premium=true`, `auth0_user_id` set; one `stripe_webhook_events` row `done`. |
| **SUB-02** | Fold (circle) yearly | Same with `tier=circle`, yearly. | Circle subscriber group; **no** Beehiiv premium; `circle_provisioned=true`. |
| **SUB-03** | Bundle | Same with `tier=bundle`. | Both axes. |
| **SUB-04** | PWYC above the floor | Enter an amount above the floor. | Sub uses inline `price_data` on the catalog product at that amount; `membership.amount_cents` matches. |
| **SUB-05** | PWYC below the floor / not a whole number | Enter below the floor, or a fractional amount. | 400; no session, nothing created. |
| **SUB-06** | Promo code | Type a valid Stripe promotion code at checkout; and separately, with a house sale live (`/api/promo/active`), confirm it's applied without typing. | Discount on the first invoice; the better of the two wins; activation normal. |
| **SUB-07** | Non-USD currency | Pick a non-USD currency in the selector (and check the geo default from a non-US location if possible). | Sub currency matches; price = that currency's floor; everything else normal. |
| **SUB-08** | Consent recorded | Complete SUB-01. | `record-consent` stored once for the session; a second call returns `already_recorded`. |
| **SUB-09** | Declined card | Card `…9995`. | No sub; nothing provisioned; still free. |
| **SUB-10** | 3DS | Card `…3184`: complete once, abandon once. | Complete → "Active paid". Abandon → nothing provisioned. |
| **SUB-11** | Already subscribed | Given an email with a live sub (active/trialing/past_due/unpaid); When they start checkout again. | 409 `already_subscribed`; no second Stripe sub. |
| **SUB-12** | Existing account, signed out | Given an email with a Neon row but no live sub (e.g. comp, or ended then re-buying); When checkout while signed out. | 409 `login_required`; after signing in the same checkout works. |
| **SUB-13** | Existing account buying | Given a free member who already has an Auth0 account; When they subscribe while signed in. | Activation reuses the Auth0 user (no duplicate); `checkout-session` returns 200, not a new cookie. |
| **SUB-14** | Webhook lag on return | Watch the network tab on return from payment. | `checkout-session` returns 202 `ready:false` until the sub is active, then signs in; `/api/me` never shows paid before the row exists (401 `membership_not_found` while polling is fine). |
| **SUB-15** | Rate limit | More than 5 session creates for one IP+email in an hour. | 429 with `retry-after`; no Stripe objects. |
| **SUB-16** | Invalid input | Missing/invalid `plan`, malformed email, unknown currency. | Bad plan / email → 400. Unknown currency falls back to USD (see §13 #4). |
| **SUB-17** | Welcome email login link | Open the welcome email link in a fresh browser. | Signs in via `/api/auth/email-login` and lands on the linked page. |

---

## 4. Suite B — Cancelling

Flow: `/account` → CancelFlow → `GET /api/stripe/save-offers?intent=…` → either
`POST /api/stripe/accept-save-offer` or `POST /api/stripe/cancel-subscription` →
optional `POST /api/stripe/cancellation-survey`. Cancelling is always at **period
end**, and needs a **fully signed-in** session (not one from an email link).

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **CXL-01** | Cancel at period end | Given an active member signed in via Auth0; When they cancel; Then response gives `access_until`; cancellation email arrives. | "Cancel pending": Stripe `cancel_at_period_end=true`; Neon `cancel_at` set, row live; Beehiiv / Circle unchanged; `/api/me` unchanged. |
| **CXL-02** | Survey saved | After CXL-01 submit reasons + note. | `cancellation_survey` row (`retainedProduct='full-exit'`) has the reasons and note; invalid reasons → 400. |
| **CXL-03** | Access holds until the end | Between CXL-01 and period end. | Feeds still play, Members Letter still arrives, the Fold still opens. |
| **CXL-04** | Period end tears down | Cancel the sub immediately in the Dashboard (§2.3). | "Ended" row: Neon row deleted; Beehiiv tier free (still on Ark Daily); Circle moved to the cancelled group; Auth0 user still there; `/api/me` = `free`. |
| **CXL-05** | Save offer accepted | At the offer step, accept the coupon. | No cancel; coupon on the sub; `accepted` survey row with `coupon_id`; offers match the tier (`derive-save-offers`). |
| **CXL-06** | Save offer window | Accept a coupon (CXL-05), then start cancelling again within 12 months. | No coupon offer shown (plan switches only); forcing `accept-save-offer` → 409 "already used recently". |
| **CXL-07** | Debundle instead of leaving | Bundle member picks "keep only Ark+" (or "only the Fold") in the flow. | Schedule attached (not a cancel): §6 "change pending" row; debundle email; survey row with the kept product. |
| **CXL-08** | Email-link session can't cancel | Sign in only via an email link (`/api/auth/email-login`), then try to cancel. | 401 `reauth_required`; nothing changes; UI sends them to sign in. |
| **CXL-09** | Spotify loses premium episodes at expiry | Given a paid test account that has linked Spotify through `/account/podcast-feed` (Beehiiv Open Access) and can play a premium episode in the Spotify app; When the subscription ends (cancel immediately in the test Dashboard to fire `customer.subscription.deleted`); Then, with the Spotify app left open and reopened, premium episodes stop playing and no new paid episodes arrive, while free episodes keep playing. Record **how long** Spotify takes to notice (check at ~0, 15 min, 1 h, 24 h) and **what the listener sees** (locked episodes, resubscribe prompt, or the show gone from the library). | Beehiiv tier = free right after the webhook (not unsubscribed; free newsletter still active); `/api/me` = `free`. If Spotify still plays premium after 24 h while Beehiiv shows free, that's a Beehiiv/Spotify issue to raise with Beehiiv, not a webhook bug. Nothing in our code writes to Spotify; this case is the only proof the chain works. |
| **CXL-10** | Apple / RSS feed loses premium at expiry | Same as CXL-09 with the private feed added to Apple Podcasts (or any RSS app). | Premium episodes stop refreshing / playing; record timing. |
| **CXL-11** | Not signed in / no live sub | Unauthenticated POST; and a signed-in member with no live sub. | 401; 404. No Stripe change, no survey row. |
| **CXL-12** | Cancel twice | Cancel an already-pending sub. | No error the member sees; one cancellation email (idempotency key `cancel_<sub>_<periodEnd>`). |

---

## 5. Suite C — Reactivating

`POST /api/stripe/reactivate-subscription` (fully signed-in). Clears the pending
cancel, releases any attached schedule, and drops retention coupons that no
longer fit.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **RACT-01** | Undo a pending cancel | After CXL-01, before period end. | Stripe `cancel_at_period_end=false`; Neon `cancel_at` cleared; response `next_charge_at`; Beehiiv/Circle untouched. |
| **RACT-02** | Undo a pending downgrade | After a scheduled change (TIER-03/CXL-07). | Schedule released; Neon `scheduled_tier`/`schedule_id` cleared; tier unchanged. |
| **RACT-03** | After it's already ended | Sub already deleted (CXL-04). | 404; nothing re-granted; UI sends them to `/plus` to buy again. |
| **RACT-04** | Nothing to undo | Active sub with no pending cancel or schedule. | 200, no change (it's a no-op, not an error). |
| **RACT-05** | Cancel → reactivate → cancel | Within one period. | Final Stripe + Neon state matches the last action; one cancellation email per distinct period end. |
| **RACT-06** | Re-subscribe after ending | After CXL-04, buy again via checkout. | New sub; same Auth0 user; Beehiiv back to premium; Circle moved back from cancelled to subscriber; new Neon row. |

---

## 6. Suite D — Changing tier or plan

`POST /api/stripe/change-tier` (fully signed-in, 20/hr). The timing rule:
**gaining an axis happens now and is charged now; losing an axis happens at period
end; same axes → now if the price goes up or stays the same, at period end if it
goes down.** Period-end changes attach a two-phase SubscriptionSchedule.

> ⚠️ The code marks this route **VERIFY-PENDING**
> (`server/routes/stripe/routes.ts` ~1231): schedule and proration behaviour
> still needs confirming against a real test-mode subscription. This suite is that
> confirmation.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **TIER-01** | Upgrade Ark+ → Bundle | Preview via `bundle-upgrade-preview`, then change. | Charged now (prorated invoice); Circle subscriber group now; Neon tier `bundle`; axis-added email for `circle`. |
| **TIER-02** | Upgrade with a declined card | Default card `…0341`, then TIER-01. | 402 `payment_failed`; tier unchanged everywhere. |
| **TIER-03** | Downgrade Bundle → Ark+ | Change tier. | Schedule attached; Neon `scheduled_tier=ark-plus`; **still in Circle** until the phase flips; when it flips, the Circle group moves and Beehiiv stays premium. |
| **TIER-04** | Ark+ → Fold (swap axes) | Change tier. | Gains circle now, loses arkPlus at period end: confirm what actually happens and record it. When arkPlus goes, Beehiiv drops to free. |
| **TIER-05** | Monthly → yearly | Same tier, more per year. | Now; billing cycle re-anchored; `plan` updated. |
| **TIER-06** | Lower PWYC amount | Same tier and plan, lower amount. | At period end via schedule; `pending_amount_cents` set. |
| **TIER-07** | Change the pending change | While TIER-03 is pending, pick something else. | The existing schedule is updated, not duplicated; Neon pending columns match the latest choice. |
| **TIER-08** | No-op | Choose the current tier/plan/amount. | `{changed:false}`; no Stripe writes. |
| **TIER-09** | Debundle intro coupon | Debundle within the 12-month coupon window vs outside it. | Coupon on phase 2 only inside the window. |

---

## 7. Suite E — Gifts

Flow: `/gift` → `POST /api/gift/create-checkout` (payment mode) →
`payment_intent.succeeded` (`kind=gift`) inserts a **pending** `gift` row and emails
the recipient a magic link (`/redeem?mt=…`) → the recipient clicks →
`POST /api/gift/claim` creates the Auth0 account (email verified), redeems, and
signs them in. **No Auth0 account exists before the claim.** Terms: 6 months =
182 days, 1 year = 365 days.

| ID | Title | Given / When / Then | Sync assertions |
|---|---|---|---|
| **GIFT-01** | Buy a gift | Giver buys Ark+ 6mo for a new recipient. | Pending `gift` row; claim email to recipient; `GET /api/gift/status` shows `activated` (= email sent, **not** access live); no Auth0 user yet. |
| **GIFT-02** | Claim as a new recipient | Recipient clicks the link. | Auth0 user created with `email_verified:true`; Neon row with `ark_plus_gift_expires_at` ≈ now + 182 d; Beehiiv premium; `/api/me` = `ark-plus`; signed in (email-link session). |
| **GIFT-03** | Fold / Bundle gift | Repeat GIFT-02 with `circle` and `bundle`. | Correct axes only (§1.1). |
| **GIFT-04** | Stack on an existing gift | Give a second Ark+ gift to the same recipient before the first ends. | New term starts at the old expiry (not now). |
| **GIFT-05** | Gift to a paying member | Recipient has a live Ark+ **monthly** sub. | `applied: extended`; Stripe collection paused for the term; no second axis grant. |
| **GIFT-06** | Gift to a yearly member | Recipient has a live Ark+ **yearly** sub. | `applied: extended`; `trial_end` pushed out by the term. |
| **GIFT-07** | Single-axis gift to a Bundle member | Ark+ gift to a Bundle subscriber. | `applied: credit`; customer balance credited with the amount paid (capped at list price); none if currencies differ. |
| **GIFT-08** | Link reused / expired | Click the claim link twice; and an `mt` older than 14 days. | Second click → 409 `already_redeemed` (or signs in); expired → clear error, nothing granted. |
| **GIFT-09** | Signed-in redeem fallback | Signed-in recipient uses `POST /api/gift/redeem` with the raw token. | Redeems onto the existing account; never creates one. |
| **GIFT-10** | Double-click race | Fire two claims at once. | One wins; the loser's grant is undone; one term, not two. |
| **GIFT-11** | Expiry | Set the gift expiry to the past (§2.3). | `/api/me` = `free` immediately; after reconcile, Beehiiv premium removed and the gift-only row deleted; Circle removal logged (dry run) or done (enforced). |
| **GIFT-12** | Expiry reminder | Set the expiry ~10 days out, run `/api/cron/gift-expiry-reminders` twice. | One email (ledger `gift_expiry_reminder_sends`); none for an axis a subscription also covers. |
| **GIFT-13** | Invalid input | Bad term, bad email, message > 500 chars. | 400; nothing created. |

---

## 8. Suite F — Failures and recovery

### 8.1 How the webhook responds

| Situation | Webhook returns | Who recovers |
|---|---|---|
| Bad or missing signature | 400 | — (fix the secret) |
| Event already claimed and still `processing` (< 120 s lease) | 409 | Stripe retries |
| Event already `done` | 200 `deduped` | — |
| Ledger insert itself errors | processes anyway, 200 | — (no dedup for that delivery) |
| **Beehiiv premium grant fails** during activation | **500**, claim deleted | Stripe retry |
| Stripe product lookup fails | **500** | Stripe retry |
| No `auth0_sub` could be resolved (Auth0 create failed) | **500** | Stripe retry |
| Neon write fails | **500** | Stripe retry |
| Gift claim email fails to send | **500** | Stripe retry |
| Circle provisioning fails (subscription) | **500** (after the row write on `created`; before it on `updated`) | Stripe retry |
| Circle provisioning fails (gift claim) | claim still succeeds; `GIFT-CIRCLE-FAILED … MANUAL ACTION` logged | by hand |
| Beehiiv **downgrade** fails (`tryPush`) | 200 (logged) | Nightly reconcile |
| Welcome / cancellation / payment-failed email fails | 200 (logged) | none — note it |

### 8.2 How to break one leg

- **Beehiiv:** invalid `BEEHIIV_API_KEY` or `BEEHIIV_PREMIUM_TIER_ID`.
- **Auth0:** revoke the Management client's create-user scope.
- **Circle:** invalid `CIRCLE_ADMIN_API_TOKEN` or a wrong subscriber group id.
- **Neon:** point `DATABASE_URL` at an unreachable host (breaks everything; use for FAIL-DB only).

Change the env var on the preview, redeploy, trigger the case, restore, then
resend the event and/or run the reconcile cron.

### 8.3 Failure matrix

Run each at the trigger points listed.

| ID | Leg | When | Expected immediately | Expected recovery |
|---|---|---|---|---|
| **FAIL-BV-01** | Beehiiv grant | subscription.created | 500; no Neon row; member paid but not yet provisioned; checkout return keeps polling. | Stripe retry after the fix → full "Active paid". |
| **FAIL-BV-02** | Beehiiv downgrade | subscription.deleted | 200; Neon row gone, `/api/me` free, but Beehiiv still premium → **feeds still play**. | Reconcile removes premium. ⚠️ The Ark+ pass **skips entirely when no live Ark+ rows exist** — make sure the QA database has at least one. |
| **FAIL-AU-01** | Auth0 create | subscription.created (new email) | 500 (no `auth0_sub` to key the row). Beehiiv premium may already be granted. | Stripe retry creates the user and the row. |
| **FAIL-CR-01** | Circle add | subscription.created (circle tier) | **500**, but the Neon row IS written: `/api/me` shows the tier, Ark+ half of a Bundle works; not in the Circle group; `circle_provisioned` not stamped. | Stripe retry after the fix → in the group, marker stamped, **no second welcome email**. |
| **FAIL-CR-01b** | Circle add | subscription.updated (Ark+ → Bundle upgrade) | **500 before the row write**: still reads `ark-plus` until Circle works. | Stripe retry → row `bundle`, in the group, one axis-added email. |
| **FAIL-CR-01c** | Circle add | gift claim (circle/bundle gift) | Claim succeeds; `GIFT-CIRCLE-FAILED … MANUAL ACTION` in the logs. | By hand: add them to the subscriber group. |
| **FAIL-CR-02** | Circle remove | subscription.deleted | 200; `/api/me` free, but **still in the subscriber group**. | Nightly reconcile. With `CIRCLE_RECONCILE_ENFORCE` unset it only **logs** `would remove community member <id>`; set it to `true` and it removes them. |
| **FAIL-CR-03** | Circle already a member / already gone | any | 404/409/422 treated as success. | n/a |
| **FAIL-DB-01** | Ledger insert | any | Processes without a claim. | Replays stay harmless (IDEM-01). |
| **FAIL-MULTI-01** | Beehiiv grant + Circle | subscription.created (bundle) | 500 from Beehiiv. | Retry succeeds on Beehiiv; Circle as FAIL-CR-01. |

> For each FAIL case, record the drifted state of every system, how long it
> lasted, whether the member could see it, and what fixed it.

### 8.4 Reconcile cron

`/api/cron/reconcile-entitlements`, run once per axis (`…/ark-plus` daily
03:00 UTC, `…/circle` 03:30; the bare path runs both). It **only removes** access
that Neon doesn't back, capped at 100 removals per axis per run. It never grants
and never reads Stripe.

- [ ] 401 without / with a wrong `CRON_SECRET`.
- [ ] A Beehiiv-premium `qa+` address with no Neon row is downgraded to free.
- [ ] A comp/staff row (no subscription, no gift) is **left alone**.
- [ ] An active gift is **left alone**; an expired gift-only row is deleted.
- [ ] Circle drift pass, dry run (default): `circleDryRun: true`, `circleDrift` counts the lapsed member from FAIL-CR-02, `circleRemoved: 0`, and the log names their community member id.
- [ ] Circle drift pass, enforced (`CIRCLE_RECONCILE_ENFORCE=true`): the lapsed member moves to the cancelled group; a live Fold member, a comp row, and a group member with **no site account** (e.g. a moderator) are all left alone.
- [ ] Response counts (`scanned`, `arkPlusRemoved`, `circleDrift`, `circleRemoved`, `circleDryRun`, `errors`) match what you saw.

---

## 9. Suite G — Replays and ordering

| ID | Title | Given / When / Then | Pass criteria |
|---|---|---|---|
| **IDEM-01** | Replayed created | Resend `subscription.created`. | 200 `deduped`; one row; no second welcome email. |
| **IDEM-02** | Replayed deleted | Resend `subscription.deleted`. | No error; state unchanged. |
| **IDEM-03** | Replayed gift payment | Resend `payment_intent.succeeded` (gift). | One `gift` row; one claim email. |
| **ORDER-01** | Old `updated` after `deleted` | Resend an earlier `subscription.updated` after the sub ended. | Treated as ended; nothing re-granted. |
| **ORDER-02** | Late `deleted` for an old sub | Member ended, re-subscribed (RACT-06), then resend the old sub's `deleted`. | Ignored ("not the one on the membership row"); new membership untouched. |
| **ORDER-03** | Stale `paused` | Pause then resume in the Dashboard; resend the `paused`. | Ignored; access stays. |
| **ORDER-04** | Deleted while a gift runs | Member with a live gift axis loses their sub. | Row cleared down to the gift; gift axis stays granted. |
| **ORDER-05** | Reconcile during a webhook | Run the cron while a checkout webhook is processing. | Final state consistent; the new member isn't downgraded. |

---

## 10. Suite H — Sign-in, `/api/me` and the Fold gate

`/api/me` identifies the caller from (in order) an Auth0 bearer token, a checkout
token, the `ark_session` cookie, then the checkout cookie. The tier comes from the
Neon row for that `auth0_sub`, then falls back to email → Stripe customer → row.

| ID | Title | Pass criteria |
|---|---|---|
| **ME-01** | Row decides | Delete the Neon row of an active member → `/api/me` = `free` straight away, even though Stripe is active (the reconcile doesn't re-grant; a Stripe event would). |
| **ME-02** | Email fallback | Row keyed on a different `auth0_sub` for the same Stripe customer email → still resolves the right tier. |
| **ME-03** | First sign-in, free | A free member's first `/api/me` subscribes them to Ark Daily once; repeat calls don't duplicate. |
| **ME-04** | Self-signup blocked | Sign in with a Google account / email code that has no membership account → denied ("Membership is required"), and the orphan Auth0 user deleted. |
| **ME-05** | Email-code login | Member signs in with the emailed code (not a magic link). |
| **ME-06** | Email-link session | Lifecycle email link signs in via `/api/auth/email-login`; expired (> 14 days) link goes to normal login; billing actions need a full sign-in (CXL-08). |
| **ME-07** | Fold gate | Circle login for a `circle`/`bundle` member → allowed; for `ark-plus`/free → sent to `/plus?from=fold`. |
| **ME-08** | Sign out | `POST /api/signout` and `/api/auth/logout` both clear the session; `/api/me` → 401. |

---

## 11. Suite I — Billing trouble, refunds, feeds and email

| ID | Title | Pass criteria |
|---|---|---|
| **PAY-01** | Payment fails | Renewal fails (card `…0341`): Neon `status=past_due`; **access kept**; payment-failed email linking `/account/billing`, one per retry attempt. |
| **PAY-02** | Card fixed | During PAY-01 update the card on `/account/billing`: Stripe retries succeed; status back to `active`. If a schedule is attached, its default card changes too. |
| **PAY-03** | Dunning gives up | Let Stripe's retries run out (or mark `unpaid`): `unpaid` stops granting at read time; `deleted` tears down as CXL-04. Record the real grace period set in the Stripe dashboard. |
| **REF-01** | Full refund of a subscription payment | Refund the whole charge in the Dashboard → sub cancelled immediately (no proration) → teardown as CXL-04. |
| **REF-02** | Partial refund | Refund part of a charge → nothing changes. |
| **REF-03** | Dispute | Create a dispute (test card `4000 0000 0000 0259`) → treated as a full reversal. |
| **REF-04** | Refund an unclaimed gift | Gift row → `void`; the claim link stops working (`gift_voided`). |
| **REF-05** | Refund a claimed gift | Term subtracted from the recipient's row; `GIFT-REVERSED` / `MANUAL ACTION` logged if an extension or credit needs undoing by hand. |
| **FEED-01** | Feeds appear | New Ark+ member on `/account/podcast-feed`: feeds show within ~35 s (page keeps polling); one per premium show. |
| **FEED-02** | Spotify link | Click through to Spotify, approve, land back on `/account/podcast-feed?spotify=linked` in the same tab; the follow-each-show checklist appears and ticks persist. |
| **FEED-03** | Spotify declined | Cancel at Spotify's consent screen → no "set up" tick. |
| **FEED-04** | Email me the feed | `POST /api/me/feeds/email` sends it; 4th request in an hour → 429. |
| **FEED-05** | Feed activation webhook | Adding a feed in an app fires Beehiiv's `private_feed.activated` → `beehiiv_feed_activations` row → show ticks off. |
| **NL-01** | Newsletter toggles | `/account` newsletters: free off unsubscribes, back on re-subscribes (and restores premium for members); a free member can't turn on premium (403). |
| **NL-02** | Beehiiv webhook mirror | Change a subscriber in Beehiiv → `beehiiv_subscription` updates; wrong `key` → rejected. |
| **CRON-01** | Feed setup reminders | Member with an un-set-up show gets one reminder per ledger rule. |
| **CRON-02** | Winback | A cancelled Ark+ member ~180 days out gets one winback email; unsubscribe link suppresses future ones; a current member is skipped. |
| **CRON-03** | Prune | Webhook ledger rows older than 90 days deleted. |

---

## 12. Execution & reporting

- **Order:** §2 → A → B → C → D → E → G → H → I → F last (it deliberately breaks
  things; restore every env var afterwards).
- **Per case:** ID, email, Stripe/Auth0 ids, the §1.4 row you observed for every
  system, evidence, pass/fail, notes.
- **Exit criteria for launch:**
  - [ ] Suites A–E pass for **all three tiers**, not just Ark+.
  - [ ] CXL-09 / CXL-10 timing recorded and acceptable.
  - [ ] Every FAIL case either recovers or has a ticket.
  - [ ] A production dry run of the Circle drift pass has been reviewed, and
        `CIRCLE_RECONCILE_ENFORCE` is set on purpose (on or off).
  - [ ] G (replays/ordering) all pass.
  - [ ] `/api/me` never shows paid without a live Neon row.
  - [ ] Crons are scheduled in the production Vercel project and reject bad secrets.
  - [ ] Dunning grace period in Stripe is set on purpose.

---

## 13. Known gaps to confirm (from reading the code)

1. **A failed Circle add on a gift claim isn't retried** — there's no Stripe
   redelivery behind a claim, so it's logged as `GIFT-CIRCLE-FAILED … MANUAL
   ACTION` and fixed by hand (FAIL-CR-01c). Subscriptions retry through Stripe.
2. **Circle drift removal is a dry run until `CIRCLE_RECONCILE_ENFORCE=true`.**
   Review a production dry run's list before turning it on.
3. **Beehiiv drift pass skips when there are no live Ark+ rows at all.** Deliberate
   fail-safe (an empty keep-set looks like a bad Neon read), not a bug — but seed at
   least one live Ark+ row in a QA database or FAIL-BV-02 will look broken.
4. **`change-tier` is marked VERIFY-PENDING** in the code (Suite D).
5. **Unsupported checkout currency becomes USD** instead of a 400 (SUB-16). Low
   risk: the client only offers `SUPPORTED_CURRENCIES`, and Stripe's own checkout
   shows the USD amount, so only a hand-crafted request hits it.
6. **No admin tool to comp or revoke a member** — a comp is a Neon row with no
   subscription, made by hand in SQL.
7. **Gift expiry and feed-setup reminder emails have no Resend idempotency key**;
   they rely on their ledger tables alone.

---

## 14. Automated coverage map

Run `bun test` before a manual pass. These cases already have unit coverage (all
files under `server/` unless noted), so run them by hand only as a launch smoke:

| Area | Test file(s) |
|---|---|
| Checkout session validation, existing-account guard, one live sub, rate limit | `checkout-create-session.test.ts` |
| Post-checkout sign-in, provisioning race | `checkout-session.test.ts` |
| Consent recording | `record-consent.test.ts` |
| Tier-aware provisioning, `accountCreated` | `activation.test.ts`, `activation-account-created.test.ts` |
| Webhook ledger (claim / lease / missing migration) | `stripe-webhook-idempotency.test.ts` |
| Membership row writes, stale events, refunds, disputes, dunning | `stripe-webhook-membership.test.ts` |
| Cancel not mirrored, deleted revokes, outages don't 500 | `stripe-webhook.test.ts` |
| Cancel / survey / email | `cancel-subscription.test.ts`, `cancellation-survey-row.test.ts` |
| Save offers and the 12-month window | `derive-save-offers.test.ts`, `retention.test.ts`, `cancellation-window.test.ts` |
| Reactivate | `reactivate-subscription.test.ts` |
| Change tier, previews | `change-tier.test.ts`, `bundle-upgrade-preview.test.ts`, `debundle-price-preview.test.ts` |
| Card update | `card-update.test.ts` |
| Axes, Circle sync, reconciler | `entitlement.test.ts` |
| Tier resolution + email fallback | `entitlement-resolver.test.ts`, `me.test.ts` |
| Gifts | `gift.test.ts`, `gift-redeem.test.ts`, `gift-redeem-race.test.ts`, `gift-expiry-reminders.test.ts` |
| Beehiiv sync, webhook, newsletters | `beehiiv-sync.test.ts`, `beehiiv-webhook.test.ts`, `me-newsletters.test.ts` |
| Feeds + Spotify checklist | `me-feeds-setup.test.ts`, `feed-actions.test.ts`, `src/components/FeedSetup.test.tsx` |
| Crons, winback, reminders | `routes/cron.test.ts`, `winback.test.ts`, `winback-cron.test.ts`, `feed-reminders*.test.ts` |

**Manual only:** anything that needs the real Stripe / Beehiiv / Circle / Auth0 /
Spotify accounts — end-to-end checkout for each tier, Suite D against a real
schedule, gift extension and credit in Stripe, the failure matrix's recovery,
dunning timing, and CXL-09/10.
