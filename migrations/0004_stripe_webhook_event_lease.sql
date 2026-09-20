-- 0004_stripe_webhook_event_lease.sql
--
-- Gives the Stripe webhook ledger (stripe_webhook_events) a lease, so a claim
-- can be told apart from a finished event.
--
-- The handler claims event.id BEFORE dispatch and releases the claim only when
-- dispatch throws. A function that times out or crashes mid-dispatch never
-- reaches that release: the claim stays, Stripe's retry is answered "already
-- processed", and the event is lost — for a `customer.subscription.deleted`,
-- that is a cancelled member who keeps access.
--
-- `status` is 'processing' from claim until dispatch succeeds, then 'done'.
-- `claimed_at` is when the current claim was taken. A delivery that finds a
-- 'processing' row older than the lease (two minutes; the function's
-- maxDuration is 60s) takes the claim over and runs the event again — every
-- handler is written to be re-run. One that finds a younger 'processing' row is
-- told to come back later, not told it succeeded.
--
-- Rows that already exist are events that were dispatched under the old
-- single-state ledger, so the column defaults to 'done'. The handler always
-- writes `status` explicitly; the default only ever describes those old rows.
--
-- The monthly prune (/api/cron/prune-webhook-events) keys on received_at and is
-- unaffected.
--
-- The handler tolerates this migration not having run yet (it falls back to the
-- single-state claim), so deploy and migrate may land in either order.
--
-- Idempotent.

alter table stripe_webhook_events
  add column if not exists status text not null default 'done';

alter table stripe_webhook_events
  add column if not exists claimed_at timestamptz;
