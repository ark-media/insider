-- 0008_spotify_linked.sql
--
-- Remembers that a member linked Spotify, per premium show.
--
-- A successful link sends the member on to Spotify's own success page
-- (content-access.spotify.com/oauth/success), so they never come back to the
-- `?spotify=linked` return URL that used to reveal the follow checklist. This
-- column is what brings the checklist back on a later visit to the setup page
-- (src/components/FeedSetup.tsx), on any device.
--
-- Per show rather than per member because one link unlocks every premium show
-- the member holds, and beehiiv_feed_activations is already one row per member
-- per show. Stamped once (coalesce keeps the first) alongside pending_at by
-- POST /api/me/feeds/setup with `via: "spotify"`, and never cleared: an
-- unlink happens on Spotify's side and nobody tells us.
--
-- Idempotent.

alter table beehiiv_feed_activations
  add column if not exists spotify_linked_at timestamptz;
