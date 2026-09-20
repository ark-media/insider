# Migrations

SQL migrations for the Neon Postgres database. The runner is `scripts/migrate.ts`
— a thin wrapper around `@neondatabase/serverless`'s `Pool` client. There is no
ORM; migrations are plain SQL.

## Usage

```bash
# Apply all pending migrations (against $DATABASE_URL — the DIRECT url, see below).
# Prints the target host + database first. Outside CI it refuses without --yes,
# unless the host is localhost.
DATABASE_URL="<direct url>" bun run migrate --yes

# Show which migrations have been applied and which are pending. Also prints
# the target, so it doubles as "where would this land?".
bun run migrate:status

# Scaffold a new migration file with the next sequence number.
bun run migrate:create add-foo-table
```

**Migrations need the direct connection string, not the pooled one.** The
runner holds a session-level advisory lock for the whole run, and Neon's pooler
(PgBouncer in transaction mode) doesn't support those: the lock and its unlock
can land on different server connections, leaving the lock held and the next
run hung. Neon's own guidance is the same — schema migrations use a direct
connection.

The direct URL is the pooled one with `-pooler` removed from the host
(`ep-foo-pooler.c-7…` → `ep-foo.c-7…`), or Neon console → Connection string
with connection pooling switched off. The app itself keeps the pooled URL.

`.env` holds the pooled URL for the dev server, so override it for migrations
— a variable set in the shell takes precedence over `.env` under Bun. The role
needs DDL privileges in that database.

## Where migrations run

| Where | Database | How |
| --- | --- | --- |
| Local | `ark-insider-dev` | `DATABASE_URL="<dev direct url>" bun run migrate --yes` |
| Staging (`main`) | `ark-insider-dev` | CI on merge, `preview` environment |
| Production (`production`) | `ark-insider-prod` | CI on push, `production` environment, approval required |

**Local and staging share `ark-insider-dev`.** A migration you apply locally
is live on staging too, and it will be a no-op when your merge reaches CI.
Grab the dev direct URL from the Neon console (switch to the `Hannah` org →
`ark-insider-dev` → Connection string → pooling off).

**CI.** `.github/workflows/migrate.yml` runs `bun run migrate` on pushes to
`main` and `production` that touch `migrations/`, the runner, or the workflow
itself. The branch picks the GitHub Environment, and the environment supplies
`DATABASE_URL`. The full picture, including how this lines up with Vercel, is
in `docs/deploys.md`.

**Manual re-run → `workflow_dispatch`.** If a migration needs to re-run (e.g.
someone applied it by hand and didn't record it), trigger the workflow from
the Actions tab, dispatching from the branch whose database you mean. Only
`main` and `production` are accepted.

### Environment setup

Both environments exist and are configured (2026-09-16):

- **`preview`** — secret `DATABASE_URL` = `ark-insider-dev` direct URL. No
  reviewers, so merges migrate staging immediately.
- **`production`** — secret `DATABASE_URL` = `ark-insider-prod` direct URL.
  Required reviewer, so every run pauses for "Approve and deploy".

Keep the secrets on the **environments**, never at repo level: a repo-level
secret is readable from any workflow run and would bypass the approval gate.
These are the same databases Vercel's `DATABASE_URL` points at, but on the
direct host where Vercel uses the pooled one. GitHub can't see Vercel's
variables, so a rotated database password has to be updated in both places.

## The squashed baseline

`0001_initial_schema.sql` is the whole schema. The former 0001–0025 sequence
was collapsed into it before launch: it creates exactly the 17 tables the
application reads and writes, with exactly the columns and indexes it uses, and
seeds the 2 careers and 32 FAQs. Nothing that was later dropped (the soft-launch
flag, the Supporting Cast mirror, the single-column gift expiry, the superseded
FAQ corpora) is reproduced.

The squash was verified against production: applying this one file to an empty
database yields a schema byte-identical to prod's — 121 columns and 30 indexes,
matching — and the same seed rows.

**Adopting it on a database that already ran 0001–0025** means baselining the
ledger (dev and prod both were, on 2026-09-16), because `0001_initial_schema.sql` is already
recorded by name — `migrate` is a no-op there, and `migrate:status` would
report drift on 0001 plus 22 orphans. The schema already matches, so only the
ledger needs rewriting:

```sql
delete from _migrations;
insert into _migrations (name, sha256)
values ('0001_initial_schema.sql', '<sha256 of the file>');
```

Get the hash with `shasum -a 256 migrations/0001_initial_schema.sql`. A brand
new database needs none of this — just `bun run migrate --yes`.

## Conventions

- Files are named `NNNN_short_description.sql` (four-digit zero-padded
  sequence). Order matters: the runner applies them in lexicographic order.
- **Use `IF NOT EXISTS` for tables, indexes, and columns**, and keep seeds
  idempotent, so a file can be safely re-applied — a partially-applied
  migration can then just be re-run.
- Each file runs in a single transaction. If any statement fails, nothing
  in that file is committed and `_migrations` is not updated. Statements
  that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`,
  `VACUUM`, `ALTER TYPE … ADD VALUE` in older Postgres) therefore can't go
  in a regular migration — split them into their own file and apply by hand
  if you need them.
- **No down migrations.** Pre-launch, breaking changes get a new forward
  migration, not a rollback. Add a `_down` companion only if a real rollback
  story emerges.
- **`faqs` content lives here, and a test parses it.**
  `src/lib/support/search.fixtures.ts` reads the newest migration containing
  `insert into faqs (display_order, category, question, answer)` and the newest
  containing `update faqs set key = v.key`, so a future FAQ migration must keep
  those two statement shapes and the `$C$`/`$Q$`/`$A$` dollar-quoting.
- Don't edit a migration after it has been applied to any environment.
  Create a new one instead. The runner records each file's sha256 on apply
  and `bun run migrate:status` flags any file whose hash diverges from
  what's recorded.

## Concurrency

`bun run migrate` acquires a Postgres advisory lock (`pg_advisory_lock`) for
the duration of the apply loop, so two concurrent invocations against the
same database serialize through the DB rather than racing on the pending
set. It is a session-level lock, which is why the runner needs the direct
connection string (see Usage). The CI concurrency group only protects the GitHub Action — the
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
