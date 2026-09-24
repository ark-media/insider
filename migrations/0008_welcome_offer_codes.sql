-- 0008_welcome_offer_codes.sql
--
-- The ICMB launch welcome offer: existing Inside Call Me Back subscribers move
-- from Ark+ to the Bundle at a discount, keeping their cadence. Mailed
-- 2026-10-05, redeemable through 2026-10-31.
--
-- One row per invited member. The roster lives here rather than as Stripe
-- promotion codes on purpose: server/lib/stripe-promos.ts walks promotion codes
-- 100 at a time for 20 pages, so a few thousand personal codes would push the
-- house-sale code past the end of that scan and silently switch off the
-- site-wide sale. Stripe holds the two coupons; this table holds who may use
-- them.
--
-- `code` is the link-carrier the mail merge drops into the email, and the
-- handle the redemption is reported against. It is NOT the credential:
-- redeeming charges a card, so /api/offer/redeem runs behind
-- requireBillingEmail (a real sign-in, not an emailed link) and matches the
-- signed-in member against `email`. A forwarded email is therefore useless to
-- anyone but its owner.
--
-- Claim/redeem is two-phase, because the Stripe call in between can fail on the
-- member's card and must leave nothing behind:
--   claimed_at   set by a conditional UPDATE before subscriptions.update, so a
--                double-click finds zero rows and the second request stops.
--                Cleared again if Stripe rejects the change. A claim older than
--                a few minutes is treated as abandoned and may be re-taken, so
--                a crashed request can't lock a member out of the offer.
--   redeemed_at  set only once Stripe has confirmed the upgrade.
--
-- The `redeemed_*` columns record what actually happened, so a refund or a
-- billing question can be answered without reconstructing it from Stripe: which
-- subscription was changed, which invoice was raised, the cadence the member
-- was on, and which of the two coupons was applied.
--
-- Idempotent.

create table if not exists welcome_offer_codes (
  code                     text        primary key,
  email                    text        not null,
  cohort                   text        not null,
  created_at               timestamptz not null default now(),
  sent_at                  timestamptz,
  claimed_at               timestamptz,
  redeemed_at              timestamptz,
  redeemed_subscription_id text,
  redeemed_invoice_id      text,
  redeemed_plan            text,
  redeemed_coupon_id       text
);

-- Eligibility is looked up by the signed-in member's email, and a member gets
-- at most one code per campaign. Unique so a re-run of the generator can't
-- hand the same person two codes.
create unique index if not exists welcome_offer_codes_email_cohort_idx
  on welcome_offer_codes (email, cohort);
