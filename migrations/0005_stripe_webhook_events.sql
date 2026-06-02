-- Idempotency ledger for Stripe webhook delivery. Stripe guarantees
-- at-least-once delivery, so the same event.id can arrive more than once
-- (network retries, our own 5xx retries). Replaying an event would re-run its
-- side effects — Simplecast DELETE on subscription.deleted, the Beehiiv
-- downgrade, the entitlement flip to free, and the gift welcome email — none of
-- which are individually replay-safe. The webhook handler claims each event.id
-- here before dispatch and skips any it has already processed.
--
-- A claim is released (deleted) if dispatch fails so Stripe's retry can
-- reprocess; it is kept once dispatch succeeds (or hits a terminal, retry-won't-
-- help state) so the side effects never run twice.

create table if not exists stripe_webhook_events (
  id           text         primary key,
  type         text         not null,
  received_at  timestamptz  not null default now()
);
