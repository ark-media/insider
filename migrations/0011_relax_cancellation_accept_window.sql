-- 0011_relax_cancellation_accept_window.sql
-- Retention eligibility moves from once-ever to once per rolling 12 months for
-- promotional *coupons* (plan switches are never rate-limited — Decision #6).
--
-- The once-ever partial unique index from 0003 made a second 'accepted' row for
-- the same email impossible, which blocked re-accepting a coupon even years
-- later. Drop it so a member can accept again over time; the within-window block
-- now lives in code (server/lib/cancellation.ts hasAcceptedRetention, a 12-month
-- lookback). The insert no longer relies on this index as an ON CONFLICT
-- arbiter.
--
-- created_at (the accepted-at timestamp) is unchanged — it is the column the
-- windowed check reads. Replace the unique index with a plain composite index on
-- (email, created_at) restricted to accepted rows, so that lookback stays a
-- cheap index scan.

drop index if exists cancellation_survey_one_accept_idx;

create index if not exists cancellation_survey_accept_recent_idx
  on cancellation_survey (email, created_at desc)
  where offer_outcome = 'accepted';
