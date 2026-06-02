-- Per-member opt-in for "new content" emails we send ourselves (via Resend),
-- replacing the Supporting Cast hosted notification toggles — SC exposes no API
-- to read or write those, so we own the preference and the sending.
--
-- One row per email (lowercased, matching beehiiv_subscription). Absence of a
-- row means "no explicit choice yet"; the API treats that as the default in
-- code rather than backfilling rows here. Both default true so a member who
-- never visits the page still hears about new episodes and posts.
create table if not exists content_notification_pref (
  email            text         primary key,
  notify_episodes  boolean      not null default true,
  notify_posts     boolean      not null default true,
  created_at       timestamptz  not null default now(),
  updated_at       timestamptz  not null default now()
);
