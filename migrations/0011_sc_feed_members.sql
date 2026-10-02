-- 0011_sc_feed_members.sql
--
-- The Supporting Cast roster, exported once before SC is switched off
-- (scripts/export-sc-feeds.ts → scripts/import-sc-feeds.ts). It is the lookup
-- behind the permanent redirect from a member's old personalised feed URL
-- (https://inside.arkmedia.org/content/<token>.rss) to their Beehiiv feed:
-- the token carries SC's user id, this table turns that id into the email,
-- and Beehiiv is asked for the feed by email at request time.
--
-- Keyed on SC's user id — the `u` in the token — not the membership id. The
-- export checked every row: the two always agree, but the token is what
-- arrives on the wire, so that is the key.
--
-- Additive and idempotent: safe to apply before the code that reads it ships.

create table if not exists sc_feed_members (
  sc_user_id      bigint      primary key,
  sc_member_id    bigint      not null,
  email           text        not null,
  sc_status       text        not null,  -- active | alert | suspended | cancelled, as exported
  feed_url        text,                  -- null for members who never had a feed
  feed_issued_at  timestamptz,           -- the token's `d`
  imported_at     timestamptz not null default now()
);

create index if not exists sc_feed_members_email_idx on sc_feed_members (lower(email));
