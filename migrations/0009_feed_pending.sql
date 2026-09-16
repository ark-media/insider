-- 0009_feed_pending.sql
-- Server-side optimistic "set up" marker for the private-feed setup hub.
--
-- Supporting Cast's `feed.activated` webhook (mirrored in sc_feed_activations)
-- is authoritative but can lag a member's setup action by minutes. We used to
-- bridge that gap with a client-side localStorage marker; this column moves
-- that optimism server-side so it persists across devices and reloads without
-- any browser storage.
--
-- `pending_at` is set the moment a member takes a setup action (opens a deep
-- link, copies the feed URL, texts themselves the link, or links Spotify for
-- the whole network). The setup hub treats a feed as done if it is either
-- confirmed (`activated = true`) OR pending (`pending_at is not null`), while
-- the reminder cron continues to key on `activated = true` only — so a member
-- who clicked but never actually activated still gets nudged.
--
-- Never downgrades a confirmed activation: the pending write only sets
-- `pending_at` and leaves `activated`/`activated_at` alone.

alter table sc_feed_activations
  add column if not exists pending_at timestamptz;
