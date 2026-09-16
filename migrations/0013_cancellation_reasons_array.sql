-- 0013_cancellation_reasons_array.sql
-- The cancellation survey is now multi-select (checkboxes) — a member can pick
-- several reasons. Replace the single `reason text` column (0002) with a
-- `reasons text[]`. Existing single-reason rows are backfilled into a one-element
-- array; accept rows (reason was null) become an empty array.
--
-- Aggregation switches to unnest(reasons) (see server/lib/cancellation.ts) so a
-- multi-reason response counts toward each reason it names. Filtering uses
-- `<slug> = any(reasons)`.

alter table cancellation_survey
  add column if not exists reasons text[] not null default '{}';

update cancellation_survey
  set reasons = array[reason]
  where reason is not null
    and reasons = '{}';

alter table cancellation_survey
  drop column if exists reason;
