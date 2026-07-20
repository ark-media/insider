-- 0010_membership.sql
-- The membership + gift tables — Neon becomes the single entitlement authority.
--
-- Today entitlement lives in three disagreeing places (Supporting Cast for
-- /api/me, an Auth0 tier claim for newsletters/Circle, Stripe for the
-- reconciler). This table collapses them: every server-side gate reads the same
-- Neon-backed resolver, and SC / Circle / Auth0 stop being entitlement
-- authorities. See tasks/entitlement-tiers.md §3.
--
-- Keyed on the Auth0 `sub` (opaque user_id), never email — Neon stores no PII,
-- only opaque identifiers. Addresses live in the third parties that need them
-- (Stripe, Auth0, Circle, SC, Resend). On read the session's `sub` keys the row;
-- on write, checkout stamps `sub` onto the Stripe customer's metadata so the
-- webhook reads it back off the event.
--
-- Invariant: the persisted `auth0_sub` is always the post-merge PRIMARY user_id.
-- The post-login account-linking Action must resolve before any membership read
-- or write, so a secondary social identity can never mint a second row.
--
-- Entitlements ({ arkPlus, circle }) are DERIVED from `tier` via GRANTS in
-- server/entitlement.ts — never stored, so there is one source and no drift.

create table if not exists membership (
  auth0_sub              text primary key,   -- Auth0 user_id (post-merge primary); opaque, no PII
  stripe_customer_id     text,               -- NULL for redeemed gifts / comp / staff (no Stripe customer)
  stripe_subscription_id text,               -- NULL for gifts (a gift is a one-time PaymentIntent)
  sc_user_id             integer,            -- Supporting Cast's opaque user id; the arkPlus join key.
                                             --   Captured when the webhook provisions the SC user.
                                             --   NULL for anyone without an SC feed (Circle-only, free).
  tier                   text not null,      -- ark-plus | circle | bundle | free
  status                 text not null,      -- Stripe subscription status, or 'active' for redeemed gifts.
                                             --   Absence of a row = free (no free rows are ever written).
                                             --   Dunning (task 9) keys on this.
  plan                   text,               -- monthly | yearly
  amount_cents           integer,
  current_period_end     timestamptz,
  cancel_at              timestamptz,
  gift_expires_at        timestamptz,        -- set on a redeemed-gift term; the reconciler must not
                                             --   downgrade before this passes
  -- Pending period-end change (the tier-switch flow, task 14). A downgrade /
  -- PWYC-lowering is a Stripe subscription schedule; these columns let the app
  -- represent "on Bundle now, dropping to Ark+ at period end" so it can display
  -- and safely mutate that state.
  scheduled_tier         text,
  schedule_id            text,
  pending_amount_cents   integer,
  pending_plan           text,
  updated_at             timestamptz not null default now()
);

create index if not exists membership_customer_idx on membership (stripe_customer_id);

-- Gifts. A gift grants nothing until redeemed, so it needs no membership row —
-- and no recipient identity — at purchase time. Keyed on an opaque redemption
-- token that travels in the link, never on a person. See §3 "Gifts".
--
-- At purchase: the giver pays a one-time PaymentIntent; one `gift` row is
-- written (status = 'pending'). At redemption (no deadline — redeemable
-- anytime): the recipient signs in, we verify the token is 'pending', then
-- either write a membership row with gift_expires_at (no active sub) or apply
-- the amount as Stripe account credit (already active). Either way the gift
-- flips to 'redeemed'. An unredeemed gift is a standing deferred-revenue
-- liability (a deliberate product call — no expiry).

create table if not exists gift (
  redemption_token   text primary key,   -- opaque; travels in the link
  tier               text not null,      -- ark-plus | circle | bundle
  plan               text,               -- monthly | yearly, or a raw duration
  amount_cents       integer,
  giver_sub          text,               -- opaque Auth0 sub of the giver; audit / refunds
  status             text not null,      -- pending | redeemed
  redeemed_by        text,               -- recipient's Auth0 sub, set at redemption
  created_at         timestamptz not null default now()
);
