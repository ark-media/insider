-- 0005_admin_audit_log.sql
--
-- Audit trail for the back office (server/lib/admin-audit.ts). One row per
-- successful admin mutation — a promo created or deleted, an announcement, FAQ
-- or job posting saved, a reminder campaign reconfigured — and one per bulk read
-- of member data (the cancellations CSV, the support log, a member-directory
-- page). Until now the only record that any of it happened was whatever the
-- change itself left behind, and a delete leaves nothing.
--
-- `admin_email` is who acted, as the session had it at the time; `admin_sub` is
-- the Auth0 user id, nullable because a session minted without one is still an
-- admin session. Neither is a foreign key: the row has to outlive the admin's
-- account, and there is no admins table to point at anyway (the role lives in
-- Auth0).
--
-- `path` is the pathname only, never the query string — that is where a
-- member-directory search carries the email being looked up. `summary` is a
-- short human-readable note (a coupon code and its percent, an export's filter
-- and row count). It deliberately holds no secrets, no exported rows, and no
-- member details beyond what names the target.
--
-- Append-only by convention: the application only ever inserts. Nothing prunes
-- it; at back-office volumes it stays small for years.
--
-- The writer tolerates this table being absent (it logs and carries on), so the
-- code may deploy before this runs. The reverse order is fine too.
--
-- Idempotent.

create table if not exists admin_audit_log (
  id          bigint      generated always as identity primary key,
  at          timestamptz not null default now(),
  admin_sub   text,
  admin_email text        not null,
  method      text        not null,
  path        text        not null,
  action      text        not null,
  target_id   text,
  summary     text
);

create index if not exists admin_audit_log_at_idx
  on admin_audit_log (at desc);
