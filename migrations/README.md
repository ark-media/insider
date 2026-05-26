# Migrations

SQL migrations for the Neon Postgres database. The runner is `scripts/migrate.ts`
— a thin wrapper around `@neondatabase/serverless`'s pooled client. There is no
ORM; migrations are plain SQL.

## Usage

```bash
# Apply all pending migrations (against $DATABASE_URL).
bun run migrate

# Show which migrations have been applied and which are pending.
bun run migrate:status

# Scaffold a new migration file with the next sequence number.
bun run migrate:create add-foo-table
```

`DATABASE_URL` must be set — use a pooled connection string (`…-pooler.…`),
same as the runtime. Migrations run with the same credentials, so the role
needs DDL privileges in that database.

## Where migrations run

Three environments, three workflows:

**Local development → a separate `ark-insider-dev` Neon project.** Don't point
local dev at the prod DB; you'll trip over your own schema changes. The dev
project is fully isolated (separate compute, separate storage, separate
billing line) — its pooled connection string is what your local `.env`
`DATABASE_URL` should point at. After cloning, run `bun run migrate` once
to bring the schema up to date.

The dev project lives in the same `Hannah` Neon org as prod; grab its
pooled URL from the console (Branches → `main` → Connection string → pick
the pooled endpoint).

**CI → production Neon main branch via GitHub Action.** Schema changes land
in `migrations/` on a feature branch, get reviewed in a PR, and merge to
`main`. `.github/workflows/migrate.yml` then runs `bun run migrate` against
the prod DB, gated by the `production-db` Environment (required reviewers
configured in repo settings). The action is path-filtered, so it only fires
when something under `migrations/` (or the runner itself) changes.

**Production manual override → `workflow_dispatch`.** If a migration needs to
re-run (e.g. someone applied it by hand and didn't record it), trigger the
workflow manually from the Actions tab. Same approval gate.

### One-time setup for the prod CI flow

1. **Add the secret.** Repo Settings → Secrets and variables → Actions →
   New repository secret: `DATABASE_URL` = the prod Neon pooled URL.
2. **Create the environment.** Repo Settings → Environments → New
   environment: `production-db`. Add yourself as a required reviewer.
3. **Move the secret onto the environment** (required — repo-level secrets
   are readable from any workflow run, bypassing the approval gate;
   environment secrets are only readable from runs that have been approved
   for `production-db`): Settings → Environments → `production-db` →
   Environment secrets → add `DATABASE_URL` there and remove the repo-level
   one.

After this, every PR that touches `migrations/` triggers a queued approval on
merge — you click "Approve and deploy" on the workflow run to apply.

## Conventions

- Files are named `NNNN_short_description.sql` (four-digit zero-padded
  sequence). Order matters: the runner applies them in lexicographic order.
- **Use `IF NOT EXISTS` for tables, indexes, and columns.** This codebase's
  prod DB pre-dates the migration system, so the first migration must be safe
  to apply against a DB where some tables already exist. Future migrations
  inherit the convention for consistency and so a partially-applied migration
  can be re-run.
- Each file runs in a single transaction. If any statement fails, nothing
  in that file is committed and `_migrations` is not updated. Statements
  that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`,
  `VACUUM`, `ALTER TYPE … ADD VALUE` in older Postgres) therefore can't go
  in a regular migration — split them into their own file and apply by hand
  if you need them.
- **No down migrations.** Pre-launch, breaking changes get a new forward
  migration, not a rollback. Add a `_down` companion only if a real rollback
  story emerges.
- Don't edit a migration after it has been applied to any environment.
  Create a new one instead. The runner records each file's sha256 on apply
  and `bun run migrate:status` flags any file whose hash diverges from
  what's recorded.

## Concurrency

`bun run migrate` acquires a Postgres advisory lock (`pg_advisory_lock`) for
the duration of the apply loop, so two concurrent invocations against the
same database serialize through the DB rather than racing on the pending
set. The CI concurrency group only protects the GitHub Action — the
advisory lock is what defends against a local-dev run colliding with the
CI run.

## Tracking

The runner maintains a `_migrations` table:

```sql
create table _migrations (
  name text primary key,
  applied_at timestamptz not null default now(),
  sha256 text
);
```

Created automatically on first run. The `sha256` column is added by
`alter table ... add column if not exists` so pre-existing tables get
upgraded forward without a separate migration.
