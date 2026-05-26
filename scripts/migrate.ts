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

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from '@neondatabase/serverless'

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))
const FILE_RE = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/

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
      applied_at timestamptz not null default now()
    )
  `)
}

async function listAppliedNames(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(
    `select name from _migrations`,
  )
  return new Set(rows.map((r) => r.name))
}

async function applyOne(client: PoolClient, name: string): Promise<void> {
  const sql = readMigration(name)
  await client.query('begin')
  try {
    await client.query(sql)
    await client.query(`insert into _migrations(name) values ($1)`, [name])
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
    const applied = await listAppliedNames(client)
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
    client.release()
    await pool.end()
  }
}

async function cmdStatus(): Promise<void> {
  const pool = newPool()
  const client = await pool.connect()
  try {
    await ensureMigrationsTable(client)
    const applied = await listAppliedNames(client)
    const all = listMigrationFiles()
    if (all.length === 0) {
      console.log('[migrate] no migrations on disk.')
      return
    }
    for (const name of all) {
      const mark = applied.has(name) ? '✓ applied ' : '· pending '
      console.log(`${mark} ${name}`)
    }
    // Orphans: migrations recorded in the DB but missing from disk. Usually
    // means a checkout from a branch that drops a migration — surface them.
    for (const name of applied) {
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

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
