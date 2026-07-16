-- 0006_feed_activations.sql
-- Persists which private feeds a member has actually activated, so the setup
-- hub can show a real "3 of 6 shows set up" count and the reminder cron knows
-- who to nudge. Supporting Cast exposes this signal ONLY through the
-- `feed.activated` webhook (the MembershipFeed REST object carries no
-- activation field), so this table is our own mirror of those deliveries.
--
-- Keyed by (email, feed_id): a member has at most one activation row per feed.
-- Email is stored already-normalized (lowercased/trimmed) by the writer so the
-- /api/me read path can join on the session email without a functional index.
-- `feed.access_revoked` flips `activated` back to false rather than deleting,
-- so we keep the history (and don't re-nudge someone who deliberately lapsed).

create table if not exists sc_feed_activations (
  email        text        not null,
  feed_id      bigint      not null,
  activated    boolean     not null default true,
  activated_at timestamptz,
  revoked_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (email, feed_id)
);

-- The hot read path is "all activations for this email" (from /api/me and the
-- reminder cron). The primary key's leading column already serves it, but keep
-- an explicit index in case the PK column order ever changes.
create index if not exists sc_feed_activations_email_idx
  on sc_feed_activations (email);

-- Idempotency ledger for Supporting Cast webhook deliveries, mirroring
-- stripe_webhook_events. SC may retry a delivery, and reprocessing is mostly
-- harmless here (the activation write is an idempotent upsert), but the ledger
-- lets us ack replays cheaply and gives an audit trail of what we received.
create table if not exists sc_webhook_events (
  id          text        primary key,
  type        text        not null,
  received_at timestamptz not null default now()
);
