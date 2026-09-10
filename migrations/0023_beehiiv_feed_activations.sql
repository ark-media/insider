-- 0023_beehiiv_feed_activations.sql
-- Replaces the Supporting Cast feed-activation mirror with a Beehiiv one.
--
-- Keyed by (email, show_id), NOT by the feed token. Beehiiv's private feed id
-- (`pod_feed_<uuid>`) ROTATES whenever the feed is reissued, so keying on it
-- would silently reset a member's "set up" state the first time that happened.
-- The show id is stable.
--
-- Beehiiv, unlike Supporting Cast, also exposes `activated` on the feed GET, so
-- this table is no longer the ONLY way to know — /api/me folds the live value in
-- as belt and braces. It still earns its place: it holds the optimistic
-- `pending_at` marker, and it is what the reminder cron reads in bulk.
--
-- Pre-launch, there is no activation history worth migrating (see the
-- greenfield note in tasks/beehiiv-private-feed.md), so the SC tables are
-- dropped outright rather than backfilled.

create table if not exists beehiiv_feed_activations (
  email        text        not null,
  show_id      text        not null,
  activated    boolean     not null default true,
  activated_at timestamptz,
  revoked_at   timestamptz,
  pending_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (email, show_id)
);

-- Hot read path is "all activations for this email" (/api/me, reminder cron).
-- The primary key's leading column already serves it; keep an explicit index in
-- case that column order ever changes.
create index if not exists beehiiv_feed_activations_email_idx
  on beehiiv_feed_activations (email);

-- Idempotency ledger for Beehiiv webhook deliveries, mirroring
-- stripe_webhook_events. The activation write is an idempotent upsert, so a
-- replay is harmless, but the ledger lets us ack replays cheaply and leaves an
-- audit trail of what we received.
create table if not exists beehiiv_webhook_events (
  id          text        primary key,
  type        text        not null,
  received_at timestamptz not null default now()
);

drop table if exists sc_feed_activations;
drop table if exists sc_webhook_events;

-- When this reader's subscription first became premium.
--
-- The feed-setup reminder cron needs a "joined" clock, and Supporting Cast's
-- roster (which carried one) is gone. `membership.created_at` can't serve:
-- membership is keyed on the Auth0 sub and deliberately stores no email, so it
-- cannot address a reminder. `beehiiv_subscription.created_at` can't either —
-- for a long-time free reader who upgrades, it's their free-signup date, which
-- would put them outside the reminder window forever.
--
-- So stamp the transition. Set once, when has_premium goes false → true, and
-- left alone afterwards; cleared on a downgrade so a re-subscribe re-stamps.
alter table beehiiv_subscription
  add column if not exists premium_since timestamptz;

-- Backfill the readers who are already premium, so the first run after this
-- migration doesn't treat every existing member as having joined just now.
update beehiiv_subscription
   set premium_since = coalesce(premium_since, created_at)
 where has_premium = true;

-- The Supporting Cast join key. Nothing writes it any more (the arkPlus axis is
-- Beehiiv's premium tier, granted by email), and the reconciler that was its
-- only reader now keys on the Auth0 sub.
alter table membership drop column if exists sc_user_id;
