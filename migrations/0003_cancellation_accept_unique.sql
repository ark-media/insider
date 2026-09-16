-- 0003_cancellation_accept_unique.sql
-- A retention offer burns once per member, ever (eligibility is checked on the
-- accept endpoint). This partial unique index is the hard backstop: it makes a
-- second 'accepted' row for the same email impossible, so two concurrent
-- accepts (double-click, replay) can't both apply the discount and the
-- read-then-write guard in accept-retention-offer can't be raced. Non-accepted
-- rows (declined / not_offered) are unconstrained — a member can have many.

create unique index if not exists cancellation_survey_one_accept_idx
  on cancellation_survey (email)
  where offer_outcome = 'accepted';
