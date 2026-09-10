-- 0024_drop_sc_import.sql
-- Drops the last Supporting Cast artefact in the schema.
--
-- `sc_import` was the staging target for the roster CSV export: one row per
-- Supporting Cast user, carrying the match back to an Auth0 user so the
-- migration could be re-run and audited. Supporting Cast is decommissioned and
-- that import never ran against this database — the table is empty — so there
-- is nothing to preserve or archive first.
--
-- 0023 dropped the other SC tables (sc_feed_activations, sc_webhook_events) and
-- membership.sc_user_id; this one was missed because nothing in the application
-- referenced it, only the migration runbook.

drop table if exists sc_import;
