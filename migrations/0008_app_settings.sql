-- 0008_app_settings.sql
-- Recreates the generic key/value settings table (originally 0004, dropped in
-- 0005 when soft-launch retired). Anticipated by 0005's own note: "If a global
-- runtime flag is ever needed again, a new migration recreates the table."
--
-- First consumer: `feed_reminder_config`, a JSON blob holding the feed-setup
-- reminder timing (enabled / delayHours / windowDays / onlyIfNoneSetUp) that
-- the back office edits and the reminder cron reads. Stored as one JSON value
-- rather than a column-per-field so future settings reuse the same table.
-- No seed row — absence means "fall back to env, then code defaults."

create table if not exists app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);
