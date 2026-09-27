-- 0010_renewal_reminder_sends.sql
--
-- One row per annual renewal reminder sent (server/lib/renewal-reminders.ts):
-- the email that goes out 30 days before a yearly membership renews. Keyed on
-- the subscription and the period end it announced, so each renewal is
-- reminded once, and next year's renewal (a new period end) gets its own.
--
-- Additive and idempotent: safe to apply before the code that writes it ships.

create table if not exists renewal_reminder_sends (
  stripe_subscription_id text        not null,
  period_end             timestamptz not null,
  sent_at                timestamptz not null default now(),
  primary key (stripe_subscription_id, period_end)
);
