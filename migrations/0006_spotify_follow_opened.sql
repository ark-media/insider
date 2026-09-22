-- 0006_spotify_follow_opened.sql
--
-- Remembers which premium shows a member has opened on Spotify from the feed
-- setup page's follow checklist (src/components/FeedSetup.tsx).
--
-- Linking Spotify through Beehiiv unlocks every premium show but follows none
-- of them, and Spotify tells nobody about follows — so the closest we can get
-- is "the member opened this show's Spotify page from the checklist". That is
-- what this column records: when, per member per show, stamped once.
--
-- It lives on beehiiv_feed_activations because that is already one row per
-- member per show, keyed the same way (email + show id). A member who opens a
-- show before any other setup state exists gets a row with activated = false
-- and no pending_at, which every existing reader already ignores.
--
-- The server is the only record: the checklist reads it back through /api/me,
-- so it follows the member across devices and the reminder emails can use it.
--
-- Idempotent.

alter table beehiiv_feed_activations
  add column if not exists spotify_follow_opened_at timestamptz;
