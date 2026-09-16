-- 0012_win_back_cancellation_record.sql
-- Win-back: make the cancellation_survey row a durable, campaign-joinable record
-- of a cancel/debundle. It already carries email (0002) — the join key to
-- beehiiv_subscription, which independently retains marketing consent and
-- survives membership teardown (Decision #8). Add:
--
--   canceled_tier    the tier the member cancelled/debundled from (ark-plus |
--                    circle | bundle) — what they left.
--   retained_product what they kept: full-exit | kept-circle | kept-ark-plus.
--
-- Both are nullable: existing rows and future accept rows (a stay, not a cancel)
-- leave them null. This record persists regardless of whether the membership row
-- is later deleted on subscription.deleted, so win-back campaigns can target by
-- email + what/why/what-was-kept without any access being implied.

alter table cancellation_survey
  add column if not exists canceled_tier    text,
  add column if not exists retained_product text;
