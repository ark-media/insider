// Neon Postgres migration runner. Plain SQL files in `migrations/`, applied
// in lexicographic order, tracked in a `_migrations` table. Each file runs in
// one transaction; partial application fails atomically.
//
// Usage (Bun auto-loads .env, so DATABASE_URL must be set there):
//   bun run migrate                 # apply pending migrations
//   bun run migrate:status          # list applied vs pending
//   bun run migrate:create <name>   # scaffold migrations/NNNN_<name>.sql
//
// Uses @neondatabase/serverless `Pool` (WebSocket) rather than the HTTP
// `neon()` client because multi-statement transactions need a single session.
// In Bun, `WebSocket` is global, so no extra setup is required.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from '@neondatabase/serverless'

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))
const FILE_RE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/

// Postgres advisory-lock key. A 64-bit int derived once for this runner so
// two concurrent `migrate` invocations against the same DB serialize through
// pg_advisory_lock instead of racing on the same pending set. The CI
// concurrency group only protects the GitHub Action — not local dev running
// against the same DB at the same time.
const ADVISORY_LOCK_KEY = 7263114882n // crc-like, constant

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILE_RE.test(f))
    .sort()
}

function readMigration(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), 'utf8')
}

function nextSequence(): string {
  const files = listMigrationFiles()
  if (files.length === 0) return '0001'
  const last = files[files.length - 1]
  const n = Number(last.slice(0, 4)) + 1
  return String(n).padStart(4, '0')
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists _migrations (
      name text primary key,
      applied_at timestamptz not null default now(),
      sha256 text
    )
  `)
  // Forward-compat for pre-existing _migrations tables that don't have the
  // sha256 column yet. Cheap, idempotent, and lets `status` flag edited files.
  await client.query(`alter table _migrations add column if not exists sha256 text`)
}

type AppliedRow = { name: string; sha256: string | null }

async function listApplied(client: PoolClient): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    `select name, sha256 from _migrations`,
  )
  return new Map(rows.map((r) => [r.name, r]))
}

async function applyOne(client: PoolClient, name: string): Promise<void> {
  const sql = readMigration(name)
  const hash = sha256(sql)
  await client.query('begin')
  try {
    await client.query(sql)
    await client.query(
      `insert into _migrations(name, sha256) values ($1, $2)`,
      [name, hash],
    )
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  }
}

async function cmdApply(): Promise<void> {
  const pool = newPool()
  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    // Serialize against concurrent runners (a workflow_dispatch race, or a
    // local dev pointed at the same DB). The lock auto-releases at session
    // end, so a crashed runner can't hold it forever.
    await client.query(`select pg_advisory_lock($1)`, [String(ADVISORY_LOCK_KEY)])
    try {
      const applied = await listApplied(client)
      const all = listMigrationFiles()
      const pending = all.filter((n) => !applied.has(n))
      if (pending.length === 0) {
        console.log('[migrate] up to date — nothing to apply.')
        return
      }
      for (const name of pending) {
        process.stdout.write(`[migrate] applying ${name}… `)
        await applyOne(client, name)
        console.log('ok')
      }
      console.log(`[migrate] applied ${pending.length} migration(s).`)
    } finally {
      await client.query(`select pg_advisory_unlock($1)`, [String(ADVISORY_LOCK_KEY)])
    }
  } finally {
    client.release()
    await pool.end()
  }
}

async function cmdStatus(): Promise<void> {
  const pool = newPool()
  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    const applied = await listApplied(client)
    const all = listMigrationFiles()
    if (all.length === 0) {
      console.log('[migrate] no migrations on disk.')
      return
    }
    for (const name of all) {
      const row = applied.get(name)
      if (!row) {
        console.log(`· pending  ${name}`)
        continue
      }
      const onDisk = sha256(readMigration(name))
      if (row.sha256 && row.sha256 !== onDisk) {
        console.log(`! drift    ${name}  (file edited since apply)`)
      } else {
        console.log(`✓ applied  ${name}`)
      }
    }
    // Orphans: migrations recorded in the DB but missing from disk. Usually
    // means a checkout from a branch that drops a migration — surface them.
    for (const name of applied.keys()) {
      if (!all.includes(name)) console.log(`! orphan   ${name}  (in DB, not on disk)`)
    }
  } finally {
    client.release()
    await pool.end()
  }
}

function cmdCreate(rawName: string | undefined): void {
  if (!rawName) {
    console.error('Usage: bun run migrate:create <name>')
    process.exit(1)
  }
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!slug) {
    console.error('Migration name must contain at least one alphanumeric character.')
    process.exit(1)
  }
  const seq = nextSequence()
  const filename = `${seq}_${slug}.sql`
  const path = join(MIGRATIONS_DIR, filename)
  const body =
    `-- ${filename}\n` +
    `-- TODO: describe what this migration changes and why.\n\n`
  writeFileSync(path, body, { flag: 'wx' })
  console.log(`[migrate] created ${filename}`)
}

function newPool(): Pool {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Add it to .env (use the pooled URL).')
    process.exit(1)
  }
  return new Pool({ connectionString: url })
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'apply'
  switch (cmd) {
    case 'apply':
    case 'up':
      await cmdApply()
      return
    case 'status':
      await cmdStatus()
      return
    case 'create':
      cmdCreate(process.argv[3])
      return
    default:
      console.error(
        `Unknown command "${cmd}". Use: apply | status | create <name>.`,
      )
      process.exit(1)
  }
}

// Scrub anything that looks like a Postgres connection string from error
// messages before logging. Some driver error paths echo the connection URL
// into the message; we don't want it surfacing in CI logs.
function scrubConnectionString(s: string): string {
  return s.replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, '<postgres-url-redacted>')
}

main().catch((err) => {
  const msg =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err)
  console.error('[migrate] failed:', scrubConnectionString(msg))
  process.exit(1)
})
