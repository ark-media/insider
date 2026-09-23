-- 0007_stripe_currency_and_gift_effects.sql
--
-- Three columns the pre-launch Stripe review found missing.
--
-- membership.currency — `amount_cents` was written from `price.unit_amount`,
--   which for a currency_options price is the USD base, so a EUR member's row
--   held a dollar figure with nothing saying so. The amount is now written in
--   the subscription's own currency and this names it. Null when amount_cents
--   is null.
--
-- gift.void_reason — 'refund' | 'dispute'. A gift voided by a dispute comes
--   back to 'pending' if the dispute is won; one voided by a refund never does.
--   Without the reason the webhook can't tell the two apart.
--
-- gift.stripe_effect — what redeeming the gift did INSIDE Stripe when it
--   overlapped a paid subscription: a pushed trial_end, a pause_collection, or
--   a customer-balance credit (routes/gift.ts). Recorded so a later refund or
--   dispute can undo exactly that, instead of logging "MANUAL ACTION".
--
-- Idempotent.

alter table membership
  add column if not exists currency text;

alter table gift
  add column if not exists void_reason text,
  add column if not exists stripe_effect jsonb;
