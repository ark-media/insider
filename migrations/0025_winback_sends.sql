-- 0025_winback_sends.sql
-- Win-back campaign bookkeeping: a send ledger and a suppression list.
--
-- The campaign's roster comes from `cancellation_survey` (0002/0012), which
-- already records who left, the tier they left, and what they kept, and which
-- survives the membership row being torn down on subscription.deleted. Nothing
-- new needs recording about the cancellation itself — only about the mail.
--
--   winback_sends       one row per (email, cohort), so a nightly cron that
--                       re-selects the same person never mails them twice.
--                       `cohort` names the campaign ('ark_plus_180d'), leaving
--                       room for a second horizon later without a schema change.
--
--   winback_suppression an opt-out. This is the one email we send to someone who
--                       is no longer a customer, so it carries a real
--                       unsubscribe link; that link writes here, and the cron
--                       excludes anyone listed regardless of cohort.
--
-- Both are keyed on email rather than auth0_sub on purpose: a member who
-- cancelled may have no membership row and no Auth0 account left, and email is
-- what cancellation_survey and beehiiv_subscription already join on.

create table if not exists winback_sends (
  email      text        not null,
  cohort     text        not null,
  sent_at    timestamptz not null default now(),
  primary key (email, cohort)
);

create table if not exists winback_suppression (
  email      text        primary key,
  created_at timestamptz not null default now()
);
