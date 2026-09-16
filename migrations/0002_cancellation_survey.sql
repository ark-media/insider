-- 0002_cancellation_survey.sql
-- Captures why an Ark+ member cancels (or that they accepted a retention
-- discount instead). One row per terminal outcome of the cancel flow:
--   offer_outcome='not_offered' → no retention offer shown; member cancelled.
--   offer_outcome='declined'    → offer shown, declined; member cancelled.
--   offer_outcome='accepted'    → offer shown and accepted; no cancel. reason
--                                 is null (we didn't ask), coupon_id is set.
-- Surfaced read-only in /admin. Keyed by email to match the rest of the app
-- (a member can map to several Stripe customers but is one email).

create table if not exists cancellation_survey (
  id            bigint        generated always as identity primary key,
  email         text          not null,
  reason        text,                        -- null when offer_outcome='accepted'
  note          text,
  offer_outcome text          not null,      -- 'accepted' | 'declined' | 'not_offered'
  coupon_id     text,                         -- set when accepted
  created_at    timestamptz   not null default now()
);

create index if not exists cancellation_survey_email_idx on cancellation_survey (email);
create index if not exists cancellation_survey_outcome_idx on cancellation_survey (offer_outcome);
