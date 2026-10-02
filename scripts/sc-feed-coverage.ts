// Dry-run coverage check for the Supporting Cast → Beehiiv feed redirect.
//
// For every SC member who had a feed (sc_feed_members.feed_url not null), asks
// Beehiiv whether that email holds a private feed on the redirect's target
// show — the exact read the redirect route makes — and joins the answer to
// what we know about the member. Nothing is written anywhere but the report.
//
// Outcomes:
//   feed              the redirect will land — fine
//   entitled_no_feed  Beehiiv premium is on but no feed on this show — Beehiiv
//                     has not minted it (or the show is wrong). FIX BEFORE CUTOVER.
//   not_entitled      no Beehiiv premium. Expected for a lapsed SC member;
//                     for an ACTIVE SC member it means they are not migrated
//                     yet. The report splits the two.
//   error             Beehiiv answered something else — re-run those rows
//
// A 422 (SHOW_IS_PUBLIC) aborts the run: SC_FEED_REDIRECT_SHOW_ID is not a
// premium show, and every row would be wrong.
//
// Usage (Bun loads .env.local: DATABASE_URL, BEEHIIV_API_KEY,
// BEEHIIV_PUBLICATION_ID_ARK_DAILY, SC_FEED_REDIRECT_SHOW_ID):
//   bun run scripts/sc-feed-coverage.ts [--limit 200] [--concurrency 6] [--out file.csv]

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getDb } from '../server/lib/db.js'
import { publicationIdFromEnv } from '../server/lib/beehiiv-feeds.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

type Row = {
  sc_user_id: string
  email: string
  sc_status: string
  has_premium: boolean | null
}

type Outcome = 'feed' | 'entitled_no_feed' | 'not_entitled' | 'error'

type Result = Row & { outcome: Outcome; beehiiv_feed_url: string; detail: string }

async function beehiivFeed(
  apiKey: string,
  pubId: string,
  showId: string,
  email: string,
): Promise<{ status: number; url?: string; body?: string }> {
  const url =
    `https://api.beehiiv.com/v2/publications/${pubId}` +
    `/podcasts/${showId}/private_feeds/by_email/${encodeURIComponent(email)}`
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 429 || res.status >= 500) {
      const body = await res.text()
      if (attempt >= 5) return { status: res.status, body: body.slice(0, 200) }
      await new Promise((r) => setTimeout(r, 1500 * attempt))
      continue
    }
    if (!res.ok) return { status: res.status, body: (await res.text()).slice(0, 200) }
    const data = (await res.json()) as { data?: { url?: string } }
    return { status: 200, url: data.data?.url }
  }
}

function csvCell(v: string | number | boolean | null): string {
  const s = v === null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function main(): Promise<void> {
  const env = process.env as Record<string, string>
  const apiKey = env.BEEHIIV_API_KEY
  const pubId = publicationIdFromEnv(env)
  const showId = env.SC_FEED_REDIRECT_SHOW_ID
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  if (!apiKey || !pubId) throw new Error('BEEHIIV_API_KEY / BEEHIIV_PUBLICATION_ID_ARK_DAILY not set')
  if (!showId) throw new Error('SC_FEED_REDIRECT_SHOW_ID is not set')

  const limit = Number(arg('--limit') ?? 0)
  const concurrency = Number(arg('--concurrency') ?? 6)
  const out = arg('--out') ?? `.tmp/sc-feed-coverage-${new Date().toISOString().slice(0, 10)}.csv`

  const sql = getDb(env)
  const rows = (await sql`
    select m.sc_user_id::text as sc_user_id, m.email, m.sc_status, b.has_premium
    from sc_feed_members m
    left join beehiiv_subscription b on lower(b.email) = lower(m.email)
    where m.feed_url is not null
    order by m.sc_status, m.sc_user_id
    ${limit > 0 ? sql`limit ${limit}` : sql``}
  `) as Row[]
  console.error(`[coverage] ${rows.length} SC members with a feed; show ${showId}`)

  const results: Result[] = new Array(rows.length)
  let next = 0
  let done = 0
  let abort: string | null = null

  async function worker(): Promise<void> {
    while (!abort) {
      const i = next++
      if (i >= rows.length) return
      const row = rows[i]!
      const r = await beehiivFeed(apiKey!, pubId!, showId!, row.email)
      let outcome: Outcome
      let detail = ''
      if (r.status === 200 && r.url) outcome = 'feed'
      else if (r.status === 404) outcome = row.has_premium ? 'entitled_no_feed' : 'not_entitled'
      else if (r.status === 422) {
        abort = `Beehiiv says show ${showId} is PUBLIC (422) — SC_FEED_REDIRECT_SHOW_ID is wrong`
        return
      } else {
        outcome = 'error'
        detail = `${r.status} ${r.body ?? ''}`
      }
      results[i] = { ...row, outcome, beehiiv_feed_url: r.url ?? '', detail }
      done++
      if (done % 250 === 0) console.error(`[coverage] ${done}/${rows.length}`)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (abort) throw new Error(abort)

  const header = [
    'sc_user_id',
    'email',
    'sc_status',
    'beehiiv_premium',
    'outcome',
    'beehiiv_feed_url',
    'detail',
  ]
  const lines = [header.join(',')]
  for (const r of results) {
    lines.push(
      [r.sc_user_id, r.email, r.sc_status, r.has_premium, r.outcome, r.beehiiv_feed_url, r.detail]
        .map(csvCell)
        .join(','),
    )
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, lines.join('\n') + '\n')

  const count = (pred: (r: Result) => boolean) => results.filter(pred).length
  const active = (r: Result) => r.sc_status === 'active' || r.sc_status === 'alert'
  console.error('')
  console.error(`wrote ${results.length} rows → ${out}`)
  console.error(`  feed (redirect lands):                 ${count((r) => r.outcome === 'feed')}`)
  console.error(`  entitled, no feed on show (FIX):       ${count((r) => r.outcome === 'entitled_no_feed')}`)
  console.error(`  not entitled, SC active (unmigrated):  ${count((r) => r.outcome === 'not_entitled' && active(r))}`)
  console.error(`  not entitled, SC lapsed (expected):    ${count((r) => r.outcome === 'not_entitled' && !active(r))}`)
  console.error(`  error (re-run):                        ${count((r) => r.outcome === 'error')}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
