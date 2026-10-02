// Load the Supporting Cast roster CSV (scripts/export-sc-feeds.ts) into the
// sc_feed_members table — the lookup behind the inside.arkmedia.org → Beehiiv
// feed redirect (server/routes/sc-feed-redirect.ts).
//
// Upserts on sc_user_id, so re-running with a fresher export updates rows in
// place; nothing is deleted. Rows without a user id are skipped and counted.
//
// Usage (Bun loads DATABASE_URL from .env.local — the POOLED url is fine, this
// is plain DML):
//   bun run scripts/import-sc-feeds.ts --file .tmp/sc-feeds-2026-10-01.csv
//
// Which database that is depends on DATABASE_URL: .env.local points at
// ark-insider-dev. For production, run with the prod url in the shell.

import { readFileSync } from 'node:fs'
import { getDb } from '../server/lib/db.js'
import { decodeScFeedToken } from '../shared/sc-feed-token.js'

const CHUNK = 1000

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

// RFC-4180 reader for the export's own output: optional quotes, doubled quotes
// inside a quoted field, LF or CRLF line ends.
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const header = rows.shift() ?? []
  return rows
    .filter((r) => r.length > 1 || (r[0] ?? '') !== '')
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

type Member = {
  scUserId: string
  scMemberId: string
  email: string
  status: string
  feedUrl: string | null
  issuedAt: string | null
}

async function main(): Promise<void> {
  const file = arg('--file')
  if (!file) throw new Error('--file <export.csv> is required')
  const env = process.env as Record<string, string>
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set')

  const records = parseCsv(readFileSync(file, 'utf8'))
  const members: Member[] = []
  let skipped = 0
  for (const r of records) {
    const scUserId = r.user_id ?? ''
    const email = (r.email ?? '').trim().toLowerCase()
    if (!/^\d+$/.test(scUserId) || !email) {
      skipped++
      continue
    }
    const feedUrl = r.feed_url || null
    const token = feedUrl ? decodeScFeedToken(feedUrl) : null
    members.push({
      scUserId,
      scMemberId: r.member_id ?? scUserId,
      email,
      status: r.status || 'unknown',
      feedUrl,
      issuedAt: token?.issuedAt?.toISOString() ?? null,
    })
  }

  // The export writes one row per (member, feed). There is one feed, so a
  // duplicate user id would mean two feeds; keep the last row for the id and
  // report it.
  const byId = new Map<string, Member>()
  for (const m of members) byId.set(m.scUserId, m)
  const unique = [...byId.values()]
  const duplicates = members.length - unique.length

  const sql = getDb(env)
  let written = 0
  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK)
    await sql`
      insert into sc_feed_members
        (sc_user_id, sc_member_id, email, sc_status, feed_url, feed_issued_at, imported_at)
      select * from unnest(
        ${chunk.map((m) => m.scUserId)}::bigint[],
        ${chunk.map((m) => m.scMemberId)}::bigint[],
        ${chunk.map((m) => m.email)}::text[],
        ${chunk.map((m) => m.status)}::text[],
        ${chunk.map((m) => m.feedUrl)}::text[],
        ${chunk.map((m) => m.issuedAt)}::timestamptz[],
        ${chunk.map(() => new Date().toISOString())}::timestamptz[]
      )
      on conflict (sc_user_id) do update set
        sc_member_id   = excluded.sc_member_id,
        email          = excluded.email,
        sc_status      = excluded.sc_status,
        feed_url       = excluded.feed_url,
        feed_issued_at = excluded.feed_issued_at,
        imported_at    = excluded.imported_at
    `
    written += chunk.length
    console.error(`[import] ${written}/${unique.length}`)
  }

  const [count] = (await sql`select count(*)::int as n from sc_feed_members`) as {
    n: number
  }[]
  console.error('')
  console.error(`csv rows:          ${records.length}`)
  console.error(`skipped (no id):   ${skipped}`)
  console.error(`duplicate user id: ${duplicates}`)
  console.error(`upserted:          ${written}`)
  console.error(`table now holds:   ${count?.n ?? '?'}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
