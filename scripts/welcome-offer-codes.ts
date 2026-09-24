// ICMB launch welcome offer — roster generation.
//
// Takes the list of invited Inside Call Me Back subscribers, mints one code
// each into `welcome_offer_codes`, and writes a CSV for the mail merge. Codes
// are the link-carrier in the email, not the credential — eligibility is
// decided by the signed-in member's own email (server/lib/welcome-offer.ts) —
// so re-running over a superset of the list tops it up rather than reissuing:
// anyone already on the roster keeps the code they were sent.
//
// Input is one email per line, or a CSV whose first column is the email (a
// header row is detected and skipped). Blank lines, duplicates and anything
// that isn't an email address are reported and skipped rather than failing the
// run, so a hand-exported list doesn't need cleaning first.
//
// Usage:
//   bun run scripts/welcome-offer-codes.ts icmb.csv                 # preview
//   bun run scripts/welcome-offer-codes.ts icmb.csv --apply         # write roster
//   bun run scripts/welcome-offer-codes.ts icmb.csv --apply --out merge.csv
//   bun run scripts/welcome-offer-codes.ts --export --out merge.csv # re-export only
//   bun run scripts/welcome-offer-codes.ts --mark-sent              # stamp sent_at
//
// DATABASE_URL must be the database the app reads (the POOLED url is fine here
// — this is DML, not a migration). Bun auto-loads .env.

import { readFileSync, writeFileSync } from 'node:fs'
import { getDb } from '../server/lib/db.js'
import {
  generateOfferCode,
  insertOfferCode,
  markCohortSent,
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_REDEEM_BY_ISO,
} from '../server/lib/welcome-offer.js'
import { isValidEmail } from '../shared/validation.js'

type Parsed = { emails: string[]; skipped: Array<{ line: number; value: string; why: string }> }

function parseList(text: string): Parsed {
  const emails: string[] = []
  const skipped: Parsed['skipped'] = []
  const seen = new Set<string>()

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line) return
    // First column only; a quoted field keeps its commas out of the split.
    const first = (line.match(/^"([^"]*)"/)?.[1] ?? line.split(',')[0] ?? '').trim()
    const email = first.toLowerCase()
    if (!email) return
    // A header row looks like a header, not an address.
    if (i === 0 && !email.includes('@')) return
    if (!isValidEmail(email)) {
      skipped.push({ line: i + 1, value: first, why: 'not an email address' })
      return
    }
    if (seen.has(email)) {
      skipped.push({ line: i + 1, value: first, why: 'duplicate' })
      return
    }
    seen.add(email)
    emails.push(email)
  })

  return { emails, skipped }
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const exportOnly = args.includes('--export')
  const markSent = args.includes('--mark-sent')
  const outArg = args.find((a) => a.startsWith('--out='))
  const outIdx = args.indexOf('--out')
  const out = outArg ? outArg.slice('--out='.length) : outIdx >= 0 ? args[outIdx + 1] : null
  const input = args.find((a) => !a.startsWith('--') && a !== out) ?? null

  const appBaseUrl = process.env.APP_BASE_URL || 'https://ark-plus.xyz'
  const sql = getDb(process.env as Record<string, string>)

  if (markSent) {
    const n = await markCohortSent(sql)
    console.log(`[welcome-offer] stamped sent_at on ${n} row(s) in ${WELCOME_OFFER_COHORT}`)
    return
  }

  if (!exportOnly) {
    if (!input) {
      console.error('Pass the list file (one email per line, or CSV with email first).')
      process.exit(1)
    }
    const { emails, skipped } = parseList(readFileSync(input, 'utf8'))
    console.log(
      `[welcome-offer] ${input}: ${emails.length} address(es)` +
        `${skipped.length > 0 ? `, ${skipped.length} skipped` : ''}` +
        `; ${apply ? 'WRITING' : 'preview only'} to cohort ${WELCOME_OFFER_COHORT}`,
    )
    for (const s of skipped.slice(0, 20)) {
      console.warn(`    line ${s.line}: ${s.why} — ${s.value}`)
    }
    if (skipped.length > 20) console.warn(`    …and ${skipped.length - 20} more`)

    if (!apply) {
      console.log('    (pass --apply to write the roster)')
    } else {
      let added = 0
      for (const email of emails) {
        if (await insertOfferCode(sql, { code: generateOfferCode(), email })) added++
      }
      console.log(
        `    ✓ ${added} new row(s); ${emails.length - added} already on the roster (code unchanged)`,
      )
    }
  }

  if (!out) return

  // Export whatever the roster now holds for this cohort — not just the rows
  // this run added — so the merge file is always the complete send list.
  const rows = (await sql`
    select code, email from welcome_offer_codes
     where cohort = ${WELCOME_OFFER_COHORT} and redeemed_at is null
     order by email
  `) as Array<{ code: string; email: string }>

  const lines = ['email,code,offer_url']
  for (const r of rows) {
    lines.push(
      [r.email, r.code, `${appBaseUrl}/offer?code=${encodeURIComponent(r.code)}`]
        .map(csvCell)
        .join(','),
    )
  }
  writeFileSync(out, lines.join('\n') + '\n', 'utf8')
  console.log(`[welcome-offer] wrote ${rows.length} row(s) to ${out}`)
  console.log(`[welcome-offer] offer closes ${WELCOME_OFFER_REDEEM_BY_ISO}`)
}

main().catch((err) => {
  console.error('[welcome-offer] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
