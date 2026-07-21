# Entitlement redesign: Ark+, Circle, Bundle

Status: agreed, hardened by a multi-agent red-team (18 verified blockers folded
in). Scope is the **Stripe sandbox (test mode) only** — live mode is untouched.

Today there is exactly one entitlement axis — `Tier = 'ark-plus-member' | 'free'`
(`server/entitlement.ts:45`). This adds Circle as a second, independent axis and
sells three SKUs across it.

| Tier | Grants | Suggested monthly | Suggested annual |
|---|---|---|---|
| Ark+ | Private feed (Supporting Cast) | $8 | $80 |
| Circle | Community (Circle access group) | $8 | $80 |
| Bundle | Both | $13 | $130 |

Pay-what-you-choose on all three, floor = suggested. (Founding Member — bundle at
≥2×, $26/mo/$260/yr — is **cut for launch**; see §5.)

Ark+ moves $5.99 → $8 and $59.99 → $80. Note this makes the FAQ seed copy in
`migrations/0001_initial_schema.sql` correct again — it already says "$8/month
or $80/year".

**§7 (open decisions) is now fully resolved** — only empirical verifications remain
(Circle email-linking + custom-field round-trip, portal render, the
`currency_options`↔Adaptive interaction), plus two build-time sub-choices in #4
(which currencies to launch with; geo-detect vs. selector).

---

## 1. Decisions (resolved)

### 1a. PWYC vs. the Billing Portal — keep PWYC

PWYC wins; the portal loses subscription switching. Tier changes get a custom
in-app flow; the portal is configured with `subscription_update` **disabled**,
leaving it payment-method + invoice history only.

Why: `custom_unit_amount` can't be set on a recurring price and is independently
incompatible with Adaptive Pricing (both verified by live probe). The sanctioned
PWYC-subscription pattern is inline `price_data`, but inline prices are unlisted
and can never be a portal switch target. The base-price × quantity workaround is
worse: the portal carries `quantity` across a product switch, silently charging
$8 for a $13 bundle.

### 1b. Legacy live-mode customers — out of scope

Live mode is untouched. Supporting cast-era customers, duplicate prices, and the 52
coupons (including permanent 100%-off comps and `inside50` ×3) stay as-is.
Deferred, not solved — they need an answer before launch, but not here.

### 1c. Circle's own paywall — we bill; Circle becomes free-to-join-if-invited

Circle's native paid membership **must be turned off in Circle admin** (task 16),
pinned to the same release that starts selling Circle. Too early and invited
members join free with no Stripe record; too late and they can double-pay.

---

## 2. Model: entitlements are a set, not a scalar

`Tier` is the SKU sold; `Entitlements` is what it grants. Keep them apart:

```ts
// server/entitlement.ts
export type Tier = 'ark-plus' | 'circle' | 'bundle' | 'free'
export type Entitlements = { arkPlus: boolean; circle: boolean }

const GRANTS: Record<Tier, Entitlements> = {
  'ark-plus': { arkPlus: true,  circle: false },
  'circle':   { arkPlus: false, circle: true  },
  'bundle':   { arkPlus: true,  circle: true  },
  'free':     { arkPlus: false, circle: false },
}
```

The two axes map 1:1 onto the two external systems already wired: `arkPlus` →
Supporting Cast, `circle` → Circle access group. `syncEntitlement` splits into two
independent syncs that can fail independently. Every call site gates on an
**entitlement**, never a tier.

**Entitlements live in exactly one place: Neon.** Greenfield lets us drop the
Auth0 entitlement mirror entirely rather than keep it in sync. Auth0 becomes
**authentication only** — it answers "who are you," never "what can you access."
So `app_metadata.tier`, the JWT tier claim, and the tier-writing in
`post-login.js` / `setAuth0Tier` are **removed**, not adapted (task 5). This is
strictly better than a mirror: a JWT claim goes stale between refreshes (the
reason `/api/me` already ignores it and does a live lookup), whereas a per-request
Neon read on the `sub` PK is never stale and is cheaper than the Management API
call `fetchAuth0TierForEmail` makes today. It also collapses provisioning to one
mechanism — a comp, a gift, and a paid sub are all just a Neon row, with no second
Auth0 write that can disagree.

Two Auth0 concerns are **not** entitlements and stay: the signup gate +
social-account linking in `post-login.js` (pure auth), and the admin **roles**
claim (`AUTH0_ROLES_CLAIM`) that gates `/admin` (role-based admin access, a
low-cardinality auth-tenant concern, orthogonal to membership). "One place" means
one place for *membership entitlements*. Circle SSO is unaffected — it
authenticates against Auth0 for identity; community *access* is the access group
we manage from the webhook/reconciler, which never read a tier claim.

### Collapse the vocabularies

Five overlapping tier vocabularies exist today (`server/entitlement.ts:45`;
`PublicMasthead.tsx:35` and `:32`; `src/data/newsletters.ts:12` +
`server/routes/circle.ts`; plus `beehiiv_subscription.has_premium`). All collapse
to: `Entitlements` for gating, `Tier` for billing/copy. This is a **leak /
false-lock surface** — every gate must be assigned the *correct axis*, not
mechanically swapped `ark-plus-member → entitlements.arkPlus`. The per-surface
mapping is enumerated in task 12; the load-bearing correction is that **community
surfaces gate on `circle`, not `arkPlus`** (see §3 risk).

---

## 3. Authority: a Neon `membership` table — but it must cover every gate

`/api/me` treats **Supporting Cast as authoritative** for paid status
(`server/routes/me.ts:143-163`). Supporting Cast can only ever answer `arkPlus` — it
knows nothing about Circle. So the second axis has no home in the current model.

Three authorities disagree by route today: `/api/me` (SC), `/api/me/newsletters`
+ `/api/circle/*` + beehiiv (Auth0 claim), reconciler (Stripe). The fix is not to
pick one of them — it's to make **Neon the single entitlement authority** and have
every server-side gate read the same Neon-backed resolver (task 11). SC and the
Circle access group stop being authorities and become pure downstream *access*
systems the webhook grants into; Auth0 exits the entitlement picture entirely (§2).
Re-pointing only `/api/me` would just move the split, not end it — a just-upgraded
member would read "subscribed" from `/api/me` while `/api/circle/community-feed`
still denied them off a stale claim.

### The `membership` table

Keyed on the Auth0 `sub` (the user's `user_id`), **not email**. Neon stores no PII —
only opaque identifiers — so the one datastore we operate isn't itself a member roster;
addresses live only in the third parties that need them (Stripe, Auth0, Circle, SC,
Resend). Both paths stay translation-free: the session's `sub` claim keys the row on
read, and on write checkout stamps `sub` onto the Stripe customer's `metadata` so the
webhook reads it back off the event — email never touches Neon. **Invariant to hold:**
the persisted `sub` is always the post-merge *primary* `user_id`; the post-login
account-linking action must resolve before any membership read or write, so a secondary
identity can never mint a second row.

```sql
create table membership (
  auth0_sub              text primary key,   -- Auth0 user_id (post-merge primary); opaque, no PII
  stripe_customer_id     text,            -- NULLable: redeemed gifts / comp / staff have none
  stripe_subscription_id text,            -- NULLable: gifts are a one-time PI
  sc_user_id             integer,         -- Supporting Cast's opaque user id; the
                                          --   arkPlus join key. NULL when no SC feed.
  tier                   text not null,   -- ark-plus | circle | bundle | free
  status                 text not null,   -- Stripe status, or 'active' for gifts
  plan                   text,            -- monthly | yearly
  amount_cents           integer,
  current_period_end     timestamptz,
  cancel_at              timestamptz,
  gift_expires_at        timestamptz,
  -- pending period-end change (tier-switch flow, task 14):
  scheduled_tier         text,
  schedule_id            text,
  pending_amount_cents   integer,
  pending_plan           text,
  updated_at             timestamptz not null default now()
);
create index membership_customer_idx on membership (stripe_customer_id);
```

Changes from the naive version, each forced by a verified finding:

- **`stripe_customer_id` / `stripe_subscription_id` are NULLable.** Redeemed gifts
  and comp/staff rows have neither (a gift is a one-time PaymentIntent, so the
  recipient has no customer and no subscription). The original `not null` made the
  `gift_expires_at` column unsatisfiable — a dead column.
- **`sc_user_id` is the arkPlus join key.** Supporting Cast is headless — no one
  logs into SC; we call its API to render the private feed on our site — so its
  opaque numeric `user_id` (not email) is what we store, captured when the webhook
  provisions the SC user. Feed rendering and SC reconciliation both key on it; email
  never persists. NULL for anyone without an SC feed (Circle-only, free).
- **Pending-change columns.** A period-end downgrade is a Stripe *schedule*; the
  app must be able to represent "on Bundle now, dropping to Ark+ at period end"
  or it can neither display nor safely mutate that state.
- **`status` is free text but its vocabulary is documented** in the migration:
  Stripe status for subscriptions, `'active'` for gifts, and absence-of-row =
  free (no free rows are written). Dunning (task 9) keys on this.
- **Entitlements are derived from `tier` via `GRANTS`, never stored** — one
  source, no drift.

### The two external join keys — no email bridge

Neither downstream system is reconciled on email. Each exposes an opaque id that
lines up with something we already hold:

- **SC → `sc_user_id`.** Stored on the row (above). Reconciliation diffs Neon's
  `sc_user_id` set against `loadAllMemberships` `user_id`s — a direct integer diff.
- **Circle → a stamped `auth0_sub` custom profile field.** We create the Circle member
  at pay time (task 4), *before* their first Circle SSO, so `sso_provider_user_id` is
  still NULL then and can't be the key. Instead we write `auth0_sub` into a Circle
  custom profile field when we provision the member. The access-group *list* returns
  only `community_member_id`, so the reconciler walks the member roster to project
  `community_member_id → auth0_sub` (via that field), then diffs against Neon's
  circle-subs. Populated at creation, uniform across paid/gift/comp, independent of
  whether SSO has happened.

Circle's add/remove and SC's create-user take **email** — but only as a write
*address*, sourced transiently from the Stripe customer (grants) or Circle's own
roster (drift removals). Email is never persisted in Neon. (Verify once wired: a member
pre-created by email, then SSO'd with that same email, **links** to the existing record
rather than duplicating it.)

### The one-row-per-person invariant needs a guard

`auth0_sub` as PK assumes one person = one subscription. Nothing enforces that today —
`findOrCreateSubscriber` (`stripe.ts:51-72`) deliberately prefers a customer
*without* an active sub, so an Ark+ holder who separately buys Circle mints a
second subscription, and its `subscription.created` webhook overwrites the row
(`ark-plus → circle`), whereupon the entitlement diff runs `scDelete` on the
still-paid Supporting Cast feed. **This is the single worst failure in the design.**

The fix (open decision, §7): either a **single-active-subscription guard** in
`create-checkout-session` that routes a second purchase into the in-place
tier-switch flow (keeps the one-row schema — recommended), or model membership
per-subscription keyed on `stripe_subscription_id` with entitlements unioned
across active rows.

### Gifts: a separate pending record, no membership row until redemption

A gift grants nothing until it's accepted, so it needs no membership row — and no
recipient identity — at purchase time. Model it as its own table keyed on an opaque
redemption token, never on a person:

```sql
create table gift (
  redemption_token   text primary key,   -- opaque; travels in the link
  tier               text not null,      -- ark-plus | circle | bundle
  plan               text,               -- or a raw duration
  amount_cents       integer,
  giver_sub          text,               -- opaque Auth0 sub; audit / refunds
  status             text not null,      -- pending | redeemed
  redeemed_by        text,               -- recipient's Auth0 sub, set at redemption
  created_at         timestamptz not null default now()
);
```

**At purchase:** the giver pays a one-time PaymentIntent; write one `gift` row. The
recipient's address goes straight to Resend (the link) and the Stripe receipt — never to
Neon. **At redemption** (no deadline — a gift is redeemable anytime): the recipient clicks
the link, signs in (post-login mints their primary `sub`), we verify the token is
`pending`, then branch on whether they already have an **active paid subscription**:

- **No active sub** → write a membership row keyed on their `sub` with `gift_expires_at =
  now + duration` and grant SC/Circle off the fresh session's email (transient).
- **Already active** → don't touch the membership row; apply `amount_cents` as **account
  credit** — a Stripe customer-balance credit on their existing customer, in the
  subscription's currency (FX-convert if the gift was paid in another), auto-drawn down
  against future invoices like a voucher.

Either way, flip the gift to `redeemed`. A gift is never wasted, so there's no blocking and
no purchase-time recipient lookup.

The entitlement duration clock runs from **redemption**. Gifts carry no redeem-by, so an
unredeemed gift is a perpetual deferred-revenue liability — a deliberate product call,
flagged here for accounting.

### What the table fixes for free

A real join key (kills the `customers.list({limit:100})` scans); a `status`
column that makes dunning expressible (`invoice.payment_failed` today only
`console.warn`s); and a local table the reconciler can diff against.

### The ordering trap

The current webhook grants the paid product (SC) **first**, then flips the
entitlement signal — deliberately, so a Circle/Auth0 outage can't block feed
access (`stripe.ts:732-734`). Writing the `membership` row *first* and having
`/api/me` derive entitlement from a bare `tier` reverses that: `/api/me` would
report "subscribed" while SC/Circle grants are still pending or failed. Task 9/10
keep the durability of an early write **without** letting a bare `tier` imply a
confirmed grant (per-axis confirmation state, or `/api/me` asserts the grant
target). See the risk list.

---

## 4. Stripe catalog

Three **persistent** products, created once via script **in test mode only**,
addressed by `lookup_key` — not `product_data` per checkout.

| Product | metadata | Prices (lookup_key → amount) |
|---|---|---|
| Ark+ | `entitlements: ark_plus`, `sc_subscription_plan_id`, `founding_multiple: 2` | `ark_plus_monthly` $8 · `ark_plus_yearly` $80 |
| Ark Community | `entitlements: circle`, `founding_multiple: 2` | `circle_monthly` $8 · `circle_yearly` $80 |
| Ark+ & Community | `entitlements: ark_plus,circle`, `sc_subscription_plan_id`, `founding_multiple: 2` | `bundle_monthly` $13 · `bundle_yearly` $130 |

Only Ark+ and Bundle carry `sc_subscription_plan_id`. **Circle-only must not
create a Supporting Cast subscription.** The webhook derives tier from the price
product's `entitlements` metadata.

**Checkout** uses the real catalog price for the exact suggested amount and inline
`price_data` with `product: PRODUCTS[tier]` (**not** `product_data`, which mints a
new Product every call — the cause of the existing sprawl) for PWYC amounts. Each
catalog price carries `currency_options` per supported currency (the per-currency
floor, §7 #4); checkout passes an explicit `currency` (geo-detected default + manual
selector, USD fallback) rather than Adaptive Pricing, which `currency_options`
disables. PWYC `price_data` uses that same currency and is validated against its floor.

**API version:** account is pinned to `2025-06-30.basil` where `ui_mode` is
`custom | embedded | hosted`. `server/routes/stripe.ts:260` uses `'elements'` and
works only because of the pin — don't "fix" it against current docs without
bumping the version.

---

## 5. Founding Member — cut for now (decided 2026-07-20)

`founding_member` is stamped at `stripe.ts:293` and **read by nothing**. Rather than
build it out, we cut it for launch: remove the stamp and the pricing-page promise, and
carry **no** `is_founding` column, `CIRCLE_FOUNDING_ACCESS_GROUP_ID`, or founding pass.
The `founding_multiple` metadata may stay on the catalog products (inert without the
reading logic) so a later revival is config-only. Tasks 9/15 carry no founding branch;
task 13 drops the checkout promise.

---

## 6. Tier switching

All Stripe mechanics below verified empirically in test mode against
`2025-06-30.basil`.

| Change | Timing | Mechanism |
|---|---|---|
| Gaining an entitlement (Ark+ → Bundle) | Immediate, prorated | `subscriptions.update` in place |
| Losing an entitlement (Bundle → Ark+/Circle) | Period end | Subscription schedule |
| Raising PWYC, same tier | Immediate, prorated | `subscriptions.update` in place |
| Lowering PWYC, same tier | Period end | Subscription schedule |
| Monthly → yearly | Immediate | Single update; resets `billing_cycle_anchor` |

Downgrades land at period end because revoking mid-period something already paid
for is wrong. Immediate changes update the item in place (preserves the item ID);
`proration_behavior: 'create_prorations'` gives exact prorations.

**Three things the naive version missed:**

1. **`price_data.currency` must come from `subscription.currency`.** A EUR sub
   updated with USD `price_data` hard-fails, so a switch reuses the sub's currency.
   With per-currency floors (§7 #4, resolved) each currency has a real floor to
   validate the switch amount against — no USD-only-floor hole. Adaptive Pricing was
   Checkout-only and never applied to these API updates anyway; it's replaced by
   explicit `currency_options` + self-managed presentment.
2. **Schedules collide with the existing billing routes.** `cancel-subscription`,
   `reactivate-subscription`, and `accept-retention-offer` call
   `subscriptions.update({ cancel_at_period_end })`, which Stripe **rejects on a
   schedule-managed sub** — so once a member has a pending downgrade, Cancel and
   Reactivate 500. And an immediate upgrade layered over a pending downgrade must
   **release the schedule first**. Task 14 makes all of these schedule-aware.
3. **The webhook diff gate is wrong for switching.** `statusChanged = created ||
   'status' in prev` skips tier changes (which move `items`, not `status`), and SC
   activation runs unconditionally on every active update. Task 9 gates fan-out on
   the **entitlement diff** instead. Switching is also the first operation that can
   **revoke** an entitlement without cancelling a subscription — a path that
   exists nowhere in the current code.

Billing-mode caveat: account is `billing_mode: classic`; mixed-interval subs would
need `flexible` — irrelevant while every tier is single-item.

---

## 7. Open decisions

Resolved 2026-07-20 unless marked **OPEN**.

1. **Concurrent subscriptions** — **RESOLVED: single-active-subscription guard.** A
   2nd purchase routes into the switch flow (task 14); keeps the one-row schema.
   Gates tasks 6/8/9/15.
2. **Community included with Ark+?** — **RESOLVED: not included.**
   `GRANTS['ark-plus'].circle = false`; community is a Circle/Bundle perk. Task 13
   must rewrite every shipped "included with Ark+ at no extra cost" surface.
3. **Gift/comp/staff in Neon vs fallback** — **RESOLVED** (§2 one-place): every
   entitlement path writes Neon (gift redemption in task 9, comp/staff rows in task
   7), so there is no permanent fallback. Comping = "insert a membership row." Only
   obligation: the task-7 backfill covers the non-subscription paths before task 10
   drops its transitional safety net.
4. **Non-USD pricing & switching** *(gates tasks 1/8/14)* — **RESOLVED: per-currency
   floors from day one.** Catalog prices carry explicit `currency_options` (a clean
   local floor per supported currency), so there is a real floor in every currency for
   both checkout and switches — this dissolves the switch-floor hole in §6 point 1.
   Cost: `currency_options` turns off Adaptive Pricing, so we self-manage currency
   **presentment** — geo-detect a default + a manual selector, pass `currency` to the
   Checkout Session; unlisted locales fall back to USD. The task-1 script writes +
   refreshes the amounts (FX drift). Verify the `currency_options`↔Adaptive interaction
   with a live probe and **disable Adaptive Pricing in the Dashboard** once currencies
   are enumerated (a mix reopens the floorless-switch hole for the Adaptive ones). Two
   sub-decisions to pin at build: which currencies to launch with, and geo-detect vs.
   selector vs. both.
5. **Founding Member** — **RESOLVED: cut for now.** Remove the `founding_member`
   stamp and the checkout promise; no `is_founding` column, no founding access
   group. Revisit later. Tasks 9/15 carry no founding branch (§5).
6. **Free-tier contract** — **RESOLVED: no membership row = free** — absence is
   defined, distinct from the provisioning-gap 401.
7. **Portal render check** — **RESOLVED: yes, verify empirically** once a test sub
   exists (task 8/14). Low-risk; no portal is wired in code today.
8. **Gift redemption & stacking** — **RESOLVED:** no redeem-by — a gift is redeemable
   anytime; the entitlement duration clock runs from redemption. At redemption, branch
   on the recipient's active-paid status: no active sub → activate a gift term; already
   active → apply the gift amount as **account credit** (a Stripe customer-balance
   credit auto-applied to future invoices like a voucher, in the sub's currency,
   FX-converted if the gift was in another). A gift is therefore never wasted — no
   blocking, no purchase-time lookup. Caveat: no expiry ⇒ unredeemed gifts are a
   standing deferred-revenue liability.
9. **Verify Circle email-linking + custom-field round-trip** — **action, not a
   choice:** when Circle is wired, confirm (a) a member pre-created by email links to
   the existing record on first SSO (no duplicate), and (b) the stamped `auth0_sub`
   custom profile field comes back on the roster list. The Circle reconciliation key
   rests on both.
10. **Circle grant timing before first SSO** — **RESOLVED: no gap.** Task 4 creates the
    Auth0 user *and* the Circle member (and adds the access group) at pay time, so the
    add doesn't 404 and app login works immediately. Because the member is created
    pre-SSO, `sso_provider_user_id` is NULL then, so reconciliation keys on the stamped
    `auth0_sub` custom field (§3, task 15), not `sso_provider_user_id`.

---

## 8. Top risks

1. **Row clobber revokes a paid feed** — Ark+-then-Circle as two subs overwrites
   the person's row and the diff runs `scDelete` on the still-paid feed. The task-8
   single-sub guard is the linchpin.
2. **Membership-first ordering defeats the SC retry and shows false "subscribed"**
   — reading `priorTier` from a row written before fan-out makes the SC claim-
   release retry a no-op, and a bare `tier` write makes `/api/me` report paid while
   the feed still 404s. Tasks 9/10.
3. **Neon cutover downgrades gift/comp/staff** — they create no Stripe sub, so if
   the task-7 backfill misses them and Neon is the sole authority, they read free.
   Mitigation: backfill must cover the gift/comp/staff paths, verified before task
   10 drops its transitional SC safety net.
4. **Client false-lock on the removed literal** — `isArkPlusMember` and ~12 sites
   hard-check `'ark-plus-member'` through an untyped `as Me` cast; shipping the new
   `/api/me` shape (task 10) without the atomic client update (task 12) silently
   bounces every paying member to `/plus`. One release.
5. **Wrong-axis community gating** — `/api/circle/community-feed` and the community
   page gate on `arkPlus`; after the split that leaks community to Ark+-only
   members and false-locks the Circle-only members who paid for it. Tasks 11/12
   flip these to `circle`.
6. **Circle-only members have no Auth0 login** — the account is minted inside the
   SC activation path, so a Circle-only buyer who skips SC gets no identity and
   can never SSO into what they bought. Task 4 extracts provisioning first.
7. **Schedules break existing billing routes** — a pending downgrade makes Cancel,
   Reactivate, and retention 500. Task 14 makes them schedule-aware.

---

## 9. Sequence (supersedes the old 9-step plan)

**Status (2026-07-21):** Tasks 1–15 landed. Tasks 5, 10, 11, 12 shipped as the
Neon-authoritative reader migration (a shared `resolveMembership` resolver keyed
on the session `sub`, threaded through the ark_session cookie + post-activation
checkout token); task 5 removed the Auth0 tier claim entirely; task 15 rewrote the
reconciler Neon-authoritative + per-axis on opaque ids. Task 13 made checkout
tier-aware, moved Circle onto first-party checkout, rewrote the false
"community-included-with-Ark+" copy, and gave Pricing a three-tier selector (cut
Founding). Task 14 made Cancel/Reactivate/retention schedule-safe (risk 7) and
added `POST /api/stripe/change-tier`. Task 16 (Circle-admin cutover) + the
empirical verify-pending items are captured in `tasks/entitlement-cutover-runbook.md`.
**Remaining: task 17** — the test suite still needs updating from the old
(Auth0-tier / SC-authoritative) model to the Neon model, and the analytics SKU
dimension is partially wired (checkout funnel carries `tier`). Run
`scripts/backfill-membership.ts --apply` before deploying the tasks-10/11 readers.

Dependencies in brackets; ↺ reversible, ⚠ one-way. Tasks 1, 3, 6, 18 have no deps
and can start immediately.

1. **Stripe catalog script** ↺ — 3 persistent products + 6 lookup-key prices
   ($8/$80/$8/$80/$13/$130), each with `currency_options` per supported currency
   (per-currency floors), `founding_multiple` metadata (dormant, §5), archive the
   sandbox orphans. Idempotent + re-runnable to refresh FX; refuses to run against
   live. *(scripts/)*
2. **Pricing service → lookup keys** ↺ [1] — `getPlanPriceCents` and `/api/pricing`
   resolve by `lookup_key`, return a per-tier shape; migrate `promo.ts:46`. Env-var
   deletion deferred to task 8.
   *(server/lib/pricing.ts, /api/pricing, promo.ts)*
3. **Entitlement model** ↺ — `Tier`/`Entitlements`/`GRANTS`; split `syncEntitlement`
   into two independently-failing axes; `setCircleAccessGroup` keys on the `circle`
   boolean; shared `deriveEntitlements` resolver. *(server/entitlement.ts)*
4. **Extract Auth0 provisioning from the SC path** ↺ [3] — `ensureAuth0Login` +
   welcome email runs for every paid tier; SC user/subscription only when
   `GRANTS[tier].arkPlus`; the Circle branch provisions Auth0 + creates the Circle
   community member at pay time (fixes the add-404 for anyone who never joined),
   **stamps `auth0_sub` into a Circle custom profile field** (the reconciler's key),
   adds the access group, + Circle welcome copy. *(server/lib/activation.ts)*
5. **Remove entitlement from Auth0** ↺ [3] — delete `setAuth0Tier` and
   `fetchAuth0TierForEmail`; drop tier-claim writing from `post-login.js` and
   `AUTH0_TIER_CLAIM`; drop `tier` from the session/`Auth0Profile` types. **Keep**
   the signup gate, social-account linking, and the admin **roles** claim. No
   `app_metadata` migration needed (greenfield). Reversible — nothing downstream
   reads the claim once tasks 10/11 read Neon. *(auth0/, shared/, session.ts, entitlement.ts)*
6. **Migration `0010_membership.sql`** ↺ — full schema per §3 (nullable Stripe IDs,
   pending-change columns, documented status/absence vocabulary). Empty-table DDL
   only. *(migrations/)*
7. **Backfill script** ↺ [1,6] — standalone (not in the migration); tie-break when
   an email maps to many subs; include `trialing`/`past_due`; write gift recipients
   and comp/staff rows so task 10 doesn't downgrade them. *(scripts/)*
8. **Checkout for three tiers** ↺ [1,3] — catalog price for exact amount, inline
   `price_data`+`product` for PWYC, per-tier + per-currency floor from
   `currency_options`; explicit `currency` (geo-detect + selector, USD fallback) in
   place of Adaptive Pricing; **single-active-subscription guard** routes a 2nd
   purchase into task 14; checkout token carries tier/entitlements; remove
   `STRIPE_PRICE_*` env vars. *(server/routes/stripe.ts, session.ts)*
9. **Webhook: fan out on the entitlement diff** ↺ [3,4,6,8] — diff-gated (not
   `statusChanged`); `priorTier` from the row before any write, default free;
   retry-safe (fan out before claiming, or assert target state); SC only when the
   sub grants `arkPlus`, capturing `sc_user_id` from provisioning onto the row;
   deleted/paused recomputes remaining entitlements; gift PI
   writes a `gift` row (redemption, not the webhook, writes the membership row);
   recompute `amount`; `payment_intent`/dunning branches; serialize
   same-`sub` deliveries. *(server/routes/stripe.ts)*
10. **`/api/me` → Neon-authoritative** ↺ [6,9] — returns `{ tier, entitlements }`;
    Neon is the single authority, so **missing row = free** (no
    permanent Auth0/SC fallback — Auth0 has no entitlement, and every path writes
    Neon per §2). Keep a *transitional* SC-only safety net during cutover, removed
    once the task-7 backfill is verified complete (trivial in test mode).
    Circle-only not 401'd; never reports an axis before its grant is confirmed; the
    SC feed is fetched by the row's `sc_user_id` (no `findScUserByEmail` lookup).
    Ships atomically with task 12. *(server/routes/me.ts)*
11. **Re-point the other server gates at Neon** ↺ [3,6] — `callerIsArkPlusMember`
    → axis resolvers reading Neon; `/api/circle/community-feed` gates on **`circle`**;
    beehiiv + `/api/me/newsletters` on `arkPlus`; a bare checkout cookie grants
    nothing specific. No Auth0-claim fallback path remains (removed in task 5).
    *(circle.ts, beehiiv.ts, me.ts)*
12. **Collapse client vocabularies** ↺ [10] — `Me` carries entitlements;
    `isArkPlusMember = entitlements.arkPlus`, add `isCircleMember`; zero
    `'ark-plus-member'` literals remain; community on `circle`, feed on `arkPlus`,
    billing on `arkPlus||circle`; masthead + dashboard per-surface axis; PostHog
    tier widened. Atomic with task 10. *(src/lib/auth.ts, subscriberAuth.tsx, PublicMasthead.tsx, community.tsx, account/, observability.ts)*
13. **Product-truth copy + first-party Circle checkout** ↺ [2,8] — per decision #2,
    rewrite "community included with Ark+" surfaces; `CircleCommunity.tsx` drops the
    hardcoded `$2` and external join link, sources price from `/api/pricing`, opens
    our checkout; Pricing renders all three tiers. *(CircleCommunity.tsx, ShowPage.tsx, account/, plus/)*
14. **Schedule-aware tier-change flow** ↺ [8,6] — in-place update vs schedule by
    direction; currency from `subscription.currency`; destination-tier floor;
    release an attached schedule before an immediate change; cancel/reactivate/
    retention/my-subscription detect `sub.schedule`; write/clear pending columns;
    widen billing lookups past `status:'active'`; portal drops `subscription_update`.
    *(server/routes/stripe.ts, account/billing.tsx)*
15. **Reconciler rewrite** ↺ [6,9,5] — carry each sub's tier (not a bare email set);
    per-axis fan-out; drift pass diffs the correct keep-set per Circle group; honor
    gift rows; `CIRCLE_DRIFT_MAX_REMOVE` per group. Reconcile
    on **opaque ids, not email**: SC axis diffs Neon `sc_user_id`s against
    `loadAllMemberships` `user_id`s; Circle axis projects the roster's
    `community_member_id → auth0_sub` (via the stamped custom profile field) and diffs
    against Neon circle-subs. Email is only a transient write-address for add/remove.
    *(server/entitlement.ts)*
16. **Circle-admin cutover** ⚠ [8,13] — disable Circle native paid membership, in
    the **same release window** as task 8. Runbook entry for order-sensitivity.
    *(operational)*
17. **Tests + analytics SKU dimension** ↺ [8,9,12,14] — webhook (gain/lose axis,
    Circle-only skips SC, revoke-without-cancel, gift PI, retry re-heals SC),
    checkout (per-tier, guard, floor), switch (proration, schedule release);
    analytics carries tier/SKU. *(tests, analytics.ts)*
18. **Rotate leaked secrets** ⚠ — `CIRCLE_API_TOKEN`, `CIRCLE_ADMIN_API_TOKEN`,
    `CIRCLE_SSO_SECRET`, `BEEHIIV_API_KEY` are committed in `.env.example`. Rotate
    at source; commit placeholders. Independent — don't block the sequence on it.

**Smallest shippable slices:** tasks 1–3 and 6 are inert and land immediately.
Tasks 10+12 are the one unavoidable atomic pair. Task 16 must pin to task 8's
release.

---

## 10. Unrelated, but found on the way

`.env.example` (lines 121-169) contains what appear to be **real live secrets**
(task 18). Committed to git; rotate independently of this work.
