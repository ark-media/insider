-- Mirrors a reader's Beehiiv subscription state so /account/newsletters can
-- render the current preferences without hitting Beehiiv on every page load,
-- and so the webhook (subscription.deleted, .upgraded, .downgraded, etc.) has
-- a place to land its updates. One row per email — we run a single shared
-- publication, so a reader has at most one subscription record across both
-- newsletters; `has_premium` distinguishes which tier of issues they get.

create table if not exists beehiiv_subscription (
  email                   text         primary key,
  publication_id          text         not null,
  beehiiv_subscription_id text         not null,
  status                  text         not null,
  has_premium             boolean      not null default false,
  created_at              timestamptz  not null default now(),
  updated_at              timestamptz  not null default now()
);
