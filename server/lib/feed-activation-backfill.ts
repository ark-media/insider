// One-off (re-runnable) backfill of sc_feed_activations from Supporting Cast's
// download history. Members who set up their feeds BEFORE the feed.activated
// webhook existed have no activation rows; a download from a private feed is
// proof that feed is set up and in use, so we seed activations from it. This
// fixes the setup-hub progress count for existing members and stops the
// reminder cron from nudging people who are already listening.
//
// The DB write is create-if-absent (see backfillActivations), so a real
// webhook-recorded activation or revocation always wins over the derived
// download signal, and the backfill is safe to run repeatedly.
//
// BLIND SPOT: Spotify Open Access members activate by linking Spotify and then
// stream, so they never generate a download and are invisible here. The SC v1
// API doesn't expose their registration type either — only the memberships CSV
// export does. To credit them, use feed-activation-csv.ts (the CSV backfill).

import type { Sql } from './db.js'
import {
  backfillActivations,
  normalizeEmail,
  type ActivationSeed,
} from './feed-activations.js'
import { streamDownloads, type ScDownload, type ScV1Client } from './sc-client.js'

function parseFeedId(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  return n
}

// Key for the (email, feed) accumulator. A NUL (\x00) separator can't appear in
// an email or a decimal feed id, so it's collision-safe. Written as an escape
// (not a literal control byte) so the file stays text and diffs are reviewable.
function pairKey(email: string, feedId: number): string {
  return `${email}\x00${feedId}`
}

// Fold one page of downloads into the accumulator, keeping the EARLIEST
// download timestamp per (normalized email, feed) — the best estimate of when
// the feed was first activated. Mutates `acc`. Pure otherwise (no I/O), so the
// dedupe logic is unit-testable.
export function foldDownloadPage(
  acc: Map<string, ActivationSeed>,
  rows: ScDownload[],
): void {
  for (const row of rows) {
    const rawEmail = row.email?.trim()
    const feedId = parseFeedId(row.feed_id)
    if (!rawEmail || feedId === null) continue
    const email = normalizeEmail(rawEmail)
    const at = row.downloaded_at ?? null
    const key = pairKey(email, feedId)
    const existing = acc.get(key)
    if (!existing) {
      acc.set(key, { email, feedId, activatedAt: at })
      continue
    }
    // Keep the earlier timestamp. A missing timestamp never displaces a known
    // one.
    if (at && (!existing.activatedAt || at < existing.activatedAt)) {
      existing.activatedAt = at
    }
  }
}

export type BackfillSummary = {
  pages: number
  downloadsScanned: number
  pairs: number
  inserted: number
}

export async function runFeedActivationBackfill(deps: {
  sql: Sql
  sc: ScV1Client
  fromIso?: string
  maxPages?: number
}): Promise<BackfillSummary> {
  const acc = new Map<string, ActivationSeed>()
  const { pages, rows } = await streamDownloads(deps.sc, {
    fromIso: deps.fromIso,
    maxPages: deps.maxPages,
    onPage: (page) => foldDownloadPage(acc, page),
  })
  const seeds = [...acc.values()]
  const inserted = await backfillActivations(deps.sql, seeds)
  return { pages, downloadsScanned: rows, pairs: seeds.length, inserted }
}
