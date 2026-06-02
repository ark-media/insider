-- Ledger of content items we've already sent "new content" emails for, so the
-- notify-new-content cron (every few hours) never double-sends. One row per
-- item; dedup is per-item globally, not per-recipient. On the first run for a
-- content type the cron seeds every current item here WITHOUT sending, so a
-- fresh deploy doesn't blast members about the existing back catalogue.
create table if not exists notified_content (
  content_type  text         not null,   -- 'episode' | 'post'
  content_id    text         not null,
  notified_at   timestamptz  not null default now(),
  primary key (content_type, content_id)
);
