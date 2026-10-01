// Supporting Cast feed export — one CSV row per (member, private feed), with
// the member's email and their personalised feed URL.
//
// Why this exists: the SC admin export does not include per-subscriber feed
// URLs; they are only reachable through the API. We need them to build the
// inside.arkmedia.org → rss.beehiiv.com redirect table before the hostname is
// repointed, after which SC's side is unreachable.
//
// How: GET /v1/memberships?include_feeds=true pages the whole roster with each
// member's feeds embedded (500 per page), so a roster of a few thousand is a
// handful of calls. If a page comes back without the `feeds` key at all, the
// member's feeds are fetched one by one from
// GET /v1/memberships/id={id}/feeds, so the export is complete either way.
//
// Each feed URL's token is also decoded (shared/sc-feed-token.ts): `c` is the
// SC feed/content id and `u` the SC user id. Those two are what the redirect
// route keys on, so they are written as their own columns and the summary
// reports any row where `u` disagrees with `user_id` — if that count is not
// zero, the redirect must key on the full token instead.
//
// Usage:
//   SC_API_KEY=... bun run scripts/export-sc-feeds.ts [--out .tmp/sc-feeds.csv]
//
// Then load the CSV with scripts/import-sc-feeds.ts. The CSV contains member
// emails: it is written under .tmp/ (gitignored) by default and must never be
// committed.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { decodeScFeedToken } from '../shared/sc-feed-token.js'

const BASE = 'https://api.supportingcast.fm/v1'
const PAGE_SIZE = 500
const MAX_PAGES = 200

type ScFeed = {
  id?: number
  podcast_id?: number
  name?: string
  url?: string
}

type ScMembership = {
  id: number
  user_id?: number
  email?: string
  first_name?: string
  last_name?: string
  status?: string
  account_type?: string
  joined?: string
  feeds?: ScFeed[]
}

type Page<T> = { data?: T[]; current_page?: number; last_page?: number }

type Row = {
  member_id: number
  user_id: number | ''
  email: string
  first_name: string
  last_name: string
  status: string
  account_type: string
  joined: string
  feed_id: number | ''
  feed_name: string
  feed_url: string
  token_c: string
  token_u: string
  token_issued_at: string
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function scGet<T>(apiKey: string, path: string): Promise<T> {
  // Simple retry on 429/5xx: the roster is small, a flat 2s backoff is enough.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    })
    if (res.ok) return (await res.json()) as T
    const body = await res.text()
    const retryable = res.status === 429 || res.status >= 500
    if (!retryable || attempt >= 5) {
      throw new Error(`SC GET ${path} failed: ${res.status} ${body.slice(0, 300)}`)
    }
    console.warn(`[sc] ${res.status} on ${path}, retry ${attempt}/5`)
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
}

async function loadAllMemberships(apiKey: string): Promise<ScMembership[]> {
  const all: ScMembership[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await scGet<Page<ScMembership>>(
      apiKey,
      `/memberships?include_feeds=true&page=${page}&max_page_size=${PAGE_SIZE}`,
    )
    const data = res.data ?? []
    all.push(...data)
    const last = res.last_page ?? page
    const current = res.current_page ?? page
    console.error(`[sc] memberships page ${current}/${last}: ${data.length} rows`)
    if (data.length === 0 || current >= last) return all
  }
  throw new Error(`roster exceeded ${MAX_PAGES} pages; raise MAX_PAGES`)
}

async function loadMemberFeeds(apiKey: string, memberId: number): Promise<ScFeed[]> {
  const res = await scGet<ScFeed[] | { data?: ScFeed[] }>(
    apiKey,
    `/memberships/id=${memberId}/feeds`,
  )
  return Array.isArray(res) ? res : (res.data ?? [])
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows: Row[]): string {
  const header = Object.keys(rows[0] ?? emptyRow()) as (keyof Row)[]
  const lines = [header.join(',')]
  for (const r of rows) lines.push(header.map((k) => csvCell(r[k])).join(','))
  return lines.join('\n') + '\n'
}

function emptyRow(): Row {
  return {
    member_id: 0,
    user_id: '',
    email: '',
    first_name: '',
    last_name: '',
    status: '',
    account_type: '',
    joined: '',
    feed_id: '',
    feed_name: '',
    feed_url: '',
    token_c: '',
    token_u: '',
    token_issued_at: '',
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.SC_API_KEY
  if (!apiKey) throw new Error('SC_API_KEY is not set (add it to .env.local)')

  const out = arg('--out') ?? `.tmp/sc-feeds-${new Date().toISOString().slice(0, 10)}.csv`

  const members = await loadAllMemberships(apiKey)
  console.error(`[sc] ${members.length} memberships loaded`)

  const rows: Row[] = []
  const stats = {
    members: members.length,
    withFeed: 0,
    noFeed: 0,
    multiFeed: 0,
    perMemberFetches: 0,
    undecodable: 0,
    userMismatch: 0,
    feedIds: new Map<string, number>(),
  }

  for (const m of members) {
    let feeds = m.feeds
    if (feeds === undefined) {
      // include_feeds not honoured on this page: fall back to the per-member call.
      feeds = await loadMemberFeeds(apiKey, m.id)
      stats.perMemberFetches++
    }
    const base = {
      member_id: m.id,
      user_id: m.user_id ?? ('' as const),
      email: (m.email ?? '').trim().toLowerCase(),
      first_name: m.first_name ?? '',
      last_name: m.last_name ?? '',
      status: m.status ?? '',
      account_type: m.account_type ?? '',
      joined: m.joined ?? '',
    }
    const withUrl = feeds.filter((f) => f.url)
    if (withUrl.length === 0) {
      stats.noFeed++
      rows.push({ ...emptyRow(), ...base })
      continue
    }
    stats.withFeed++
    if (withUrl.length > 1) stats.multiFeed++
    for (const f of withUrl) {
      const url = f.url as string
      const tok = decodeScFeedToken(url)
      if (!tok) stats.undecodable++
      else {
        stats.feedIds.set(tok.feedId, (stats.feedIds.get(tok.feedId) ?? 0) + 1)
        if (m.user_id !== undefined && tok.userId !== String(m.user_id)) stats.userMismatch++
      }
      rows.push({
        ...base,
        feed_id: f.id ?? '',
        feed_name: f.name ?? '',
        feed_url: url,
        token_c: tok?.feedId ?? '',
        token_u: tok?.userId ?? '',
        token_issued_at: tok?.issuedAt?.toISOString() ?? '',
      })
    }
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, toCsv(rows))

  console.error('')
  console.error(`wrote ${rows.length} rows → ${out}`)
  console.error(`  memberships:           ${stats.members}`)
  console.error(`  with a feed URL:       ${stats.withFeed}`)
  console.error(`  without any feed:      ${stats.noFeed}`)
  console.error(`  with more than 1 feed: ${stats.multiFeed}`)
  console.error(`  per-member fetches:    ${stats.perMemberFetches}`)
  console.error(`  undecodable tokens:    ${stats.undecodable}`)
  console.error(`  token u ≠ user_id:     ${stats.userMismatch}`)
  console.error(
    `  distinct token c (feed id → rows): ${[...stats.feedIds].map(([c, n]) => `${c}→${n}`).join(', ') || 'none'}`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
