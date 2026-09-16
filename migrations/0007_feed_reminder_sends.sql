-- 0007_feed_reminder_sends.sql
-- Ledger of feed-setup reminder emails, so the reminder cron never nags the
-- same member twice. One row per (email, reminder_no): reminder_no lets a
-- future second-touch reminder (planned for the admin-config phase) reuse this
-- table without a schema change. Email is stored already-normalized
-- (lowercased/trimmed) to match sc_feed_activations for joins.
--
-- done_count / total_count snapshot the member's setup progress at send time —
-- useful for auditing "did the nudge move anyone" without a separate events log.

create table if not exists feed_reminder_sends (
  email        text        not null,
  reminder_no  integer     not null default 1,
  done_count   integer     not null,
  total_count  integer     not null,
  sent_at      timestamptz not null default now(),
  primary key (email, reminder_no)
);
