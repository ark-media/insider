-- 0016_gift_expiry_reminder_sends.sql
-- Ledger of gift-expiry reminder emails (T7.5), so the cron never nags the same
-- recipient twice for the same term. One row per (auth0_sub, axis, expires_at):
-- keying on the term-end means a re-gift that pushes an axis's expiry out is a
-- NEW term and becomes eligible for a fresh reminder, while a single term is only
-- ever reminded once. `axis` is 'ark_plus' | 'circle' — the per-axis gift columns
-- on membership (migration 0015). Membership stores no PII, so the recipient's
-- email is resolved from Auth0 at send time and never persisted here.

create table if not exists gift_expiry_reminder_sends (
  auth0_sub   text        not null,
  axis        text        not null,
  expires_at  timestamptz not null,
  sent_at     timestamptz not null default now(),
  primary key (auth0_sub, axis, expires_at)
);
