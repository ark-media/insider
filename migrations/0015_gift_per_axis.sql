-- 0015_gift_per_axis.sql
-- Per-axis gift stacking (tasks/prd-gift-tiers.md D4).
--
-- A gift now extends a SPECIFIC entitlement axis: an Ark+ gift extends ark_plus,
-- a Community gift extends circle, a Bundle gift extends both. The single
-- gift_expires_at column can't represent an Ark+ gift and a Community gift
-- running concurrently with independent end dates, so it is replaced by one
-- expiry per axis. The effective tier is derived (never stored) from which axes
-- are live — see server/entitlement.ts liveAxes / tierFromEntitlements.
--
-- Greenfield (pre-launch, no live gift memberships): no rows to backfill, so the
-- old column is simply dropped rather than migrated.

alter table membership drop column if exists gift_expires_at;
alter table membership add column if not exists ark_plus_gift_expires_at timestamptz;
alter table membership add column if not exists circle_gift_expires_at timestamptz;

-- The gift's charge currency (lowercase ISO, e.g. 'usd', 'gbp'). amount_cents is
-- denominated in it, so the paid-sub-overlap credit math (D5) — gift amount minus
-- the standalone gift price of each granted axis — must resolve those standalone
-- prices in this same currency. Absent (older rows) → treat as 'usd'.
alter table gift add column if not exists currency text;
