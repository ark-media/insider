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

-- Defensive drift check: the prod `announcements` table predates this
-- migration, so CREATE TABLE IF NOT EXISTS silently skips creation and would
-- mask any divergence from the schema above. Assert the invariants the app
-- code relies on so a mismatch fails this migration loudly instead of
-- becoming a permanent, undetectable difference.
do $$
declare
  expected_cols text[] := array[
    'id', 'body', 'action_url', 'bar_color', 'text_color',
    'dismissible', 'enabled', 'starts_at', 'ends_at',
    'created_at', 'updated_at'
  ];
  c text;
  col record;
begin
  foreach c in array expected_cols loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'announcements'
        and column_name = c
    ) then
      raise exception 'announcements schema drift: missing column %', c;
    end if;
  end loop;

  for col in
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'announcements'
      and column_name in ('id', 'enabled', 'starts_at', 'ends_at')
  loop
    if col.column_name = 'id' and col.data_type <> 'uuid' then
      raise exception 'announcements.id must be uuid, got %', col.data_type;
    end if;
    if col.is_nullable = 'YES' then
      raise exception 'announcements.% must be NOT NULL', col.column_name;
    end if;
  end loop;
end $$;

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
