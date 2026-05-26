-- Initial schema. Squashes the two tables that existed (or were about to
-- exist) when migration tooling was introduced: `announcements` (already
-- created by hand in prod) and `discuss_threads` (new). IF NOT EXISTS lets
-- this migration apply cleanly to both fresh dev databases and the existing
-- prod database where `announcements` predates the runner.

create table if not exists announcements (
  id           uuid          primary key default gen_random_uuid(),
  body         text          not null,
  action_url   text,
  bar_color    text          not null,
  text_color   text          not null,
  dismissible  boolean       not null default true,
  enabled      boolean       not null default true,
  starts_at    timestamptz   not null,
  ends_at      timestamptz   not null,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now()
);

create table if not exists discuss_threads (
  id                    uuid         primary key default gen_random_uuid(),
  newsletter_slug       text         not null,
  beehiiv_post_id       text         not null unique,
  beehiiv_post_title    text         not null,
  circle_thread_url     text         not null,
  circle_space_id       integer      not null,
  circle_post_id        text         not null,
  beehiiv_body_patched  boolean      not null default false,
  created_at            timestamptz  not null default now()
);

create index if not exists discuss_threads_newsletter_slug_idx
  on discuss_threads (newsletter_slug);
