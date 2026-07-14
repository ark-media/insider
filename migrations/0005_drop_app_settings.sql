-- 0005_drop_app_settings.sql
-- Drops `app_settings`, added in 0004 to hold a single key: `launch_mode`, the
-- flag that toggled the site between the focused soft-launch ("Inside Call Me
-- Back") experience and the full site. Product retired soft launch, so the flag
-- and every surface that read it are gone from the app — leaving the table would
-- leave a live row nothing reads.
--
-- Forward-only, per the convention in migrations/README.md. If a global runtime
-- flag is ever needed again, a new migration recreates the table.

drop table if exists app_settings;
