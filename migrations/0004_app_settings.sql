-- 0004_app_settings.sql
-- A tiny singleton key/value table for global runtime flags managed from the
-- admin back office. Today it holds exactly one key, `launch_mode`, which
-- toggles the site between the focused soft-launch ("Inside Call Me Back")
-- experience and the full hard-launch site. Kept generic so future global
-- switches can reuse the same table rather than each growing a column.
--
-- The app defaults to 'soft' in code when the row is missing or holds an
-- unexpected value, so seeding 'soft' here just makes the live state explicit.

create table if not exists app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

insert into app_settings (key, value) values ('launch_mode', 'soft')
  on conflict (key) do nothing;
