// One-off (re-runnable) backfill of sc_feed_activations from a Supporting Cast
// memberships CSV export. Unlike the /downloads API backfill, this credits
// Spotify Open Access members (external_registration_type = spotify), who
// stream and so never appear in download history. See
// server/lib/feed-activation-csv.ts for the why and the activation rule.
//
// Preview by default (no writes); pass --apply to write. Idempotent: the write
// is create-if-absent, so a webhook-recorded activation always wins and the
// script is safe to run repeatedly.
//
// Usage (Bun auto-loads .env; DATABASE_URL must be the pooled Neon URL):
//   bun run scripts/backfill-feed-activations-from-csv.ts <export.csv>
//   bun run scripts/backfill-feed-activations-from-csv.ts <export.csv> --apply

import { readFileSync } from 'node:fs'
import { getDb } from '../server/lib/db.js'
import { backfillActivations } from '../server/lib/feed-activations.js'
import { planCsvBackfill } from '../server/lib/feed-activation-csv.js'

// Minimal RFC-4180 CSV parser: handles quoted fields containing commas,
// newlines, and escaped ("") quotes — the SC export quotes plan names.
function parseCsv(s: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const csvPath = args.find((a) => !a.startsWith('--'))
  if (!csvPath) {
    console.error('Usage: bun run scripts/backfill-feed-activations-from-csv.ts <export.csv> [--apply]')
    process.exit(1)
  }

  const parsed = parseCsv(readFileSync(csvPath, 'utf8'))
  const header = parsed[0]
  if (!header) {
    console.error('CSV is empty.')
    process.exit(1)
  }
  // Drop blank/short trailing rows the export sometimes leaves.
  const rows = parsed.slice(1).filter((r) => r.length === header.length && (r[0] ?? '') !== '')

  const plan = planCsvBackfill(header, rows)

  console.log(apply ? '=== APPLY (writing activation rows) ===' : '=== PREVIEW (no writes) ===')
  console.log(`CSV rows:                 ${rows.length}`)
  console.log(`Unique members:           ${plan.membersSeen}`)
  console.log(`Feeds in export:          ${plan.feedsInExport.join(', ')}`)
  console.log(`Private feeds (gated):    ${plan.privateFeeds.join(', ')}`)
  console.log(`Activated members:        ${plan.membersActivated}`)
  console.log(`NOT activated members:    ${plan.membersNotActivated}`)
  console.log(`Activation seeds:         ${plan.seeds.length}`)
  console.log(`  from subscribe/download: ${plan.fromDownloads}`)
  console.log(`  from Spotify link:       ${plan.fromSpotify}`)

  if (!apply) {
    console.log('\nDry run — re-run with --apply to write these seeds to sc_feed_activations.')
    return
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set. Add the pooled Neon URL to .env.')
    process.exit(1)
  }
  // Surface the target host so an accidental prod/dev mixup is visible.
  console.log(`\nTarget DB host: ${new URL(url).host}`)

  const inserted = await backfillActivations(getDb(process.env as Record<string, string>), plan.seeds)
  console.log(`Inserted ${inserted} new activation rows (existing rows left untouched).`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
