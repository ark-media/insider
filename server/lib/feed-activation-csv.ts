// Backfill sc_feed_activations from a Supporting Cast *memberships CSV export*,
// rather than from the /downloads API (see feed-activation-backfill.ts).
//
// Why a second source: the download-derived backfill only sees members who pull
// an RSS feed. Spotify Open Access members activate by *linking their Spotify
// account* and then stream — they never generate a download, so the download
// backfill (and the setup-hub count, and the reminder cron) treat them as
// un-activated forever. On the real roster that misclassified ~3,300 listening
// members. The SC v1 memberships REST object does NOT expose the registration
// type (its keys are id/account_type/email/external_id/status/source/feeds…),
// but the CSV export does, via `external_registration_type = spotify`. So the
// CSV is the only source that can credit Spotify-linked members.
//
// This module is pure (header + rows in, seeds + a summary out) so the
// activation rule is unit-tested; the CSV read and DB write live in the runner
// script (scripts/backfill-feed-activations-from-csv.ts).

import { normalizeEmail, type ActivationSeed } from './feed-activations.js'

// SC's per-feed export columns look like "20081_inside-call-me-back_downloads":
// a leading integer feed id, a slug, then the metric. We only need the id and
// the metric.
const FEED_COL = /^(\d+)_.+_(subscribed|downloads)$/
const EMAIL_COL = 'email'
// The registration-type column. `spotify` marks a Spotify Open Access member —
// the one activation signal that never shows up as a subscribe/download.
const REG_TYPE_COL = 'external_registration_type'
const SPOTIFY = 'spotify'

type FeedCols = { sub?: number; dl?: number }

// (email, feed) accumulator key. A NUL separator can't occur in an email or a
// decimal feed id, so it's collision-safe.
function pairKey(email: string, feedId: number): string {
  return `${email}\x00${feedId}`
}

export type CsvBackfillPlan = {
  seeds: ActivationSeed[]
  // Every feed id seen in the column headers (private + public).
  feedsInExport: number[]
  // Feeds at least one member actually gated (subscribe or download). A Spotify
  // member is credited only with these — never a public feed nobody gates.
  privateFeeds: number[]
  // (email, feed) pairs credited by a subscribe/download signal.
  fromDownloads: number
  // (email, feed) pairs credited ONLY by a Spotify link — the population the
  // download-derived backfill misses.
  fromSpotify: number
  membersSeen: number
  membersActivated: number
  // Unique members with no activated feed — the true "not yet activated" count,
  // and the number that reconciles with SC's own un-activated report.
  membersNotActivated: number
}

// Does this row show a real subscribe/download for the given feed's columns?
function isDownloadActivated(row: string[], cols: FeedCols): boolean {
  const subbed = cols.sub != null && (row[cols.sub] ?? '').trim() !== ''
  const downloaded = cols.dl != null && Number(row[cols.dl] ?? 0) > 0
  return subbed || downloaded
}

// Turn a parsed memberships CSV into create-if-absent activation seeds. One seed
// per unique (normalized email, feed). CSV carries no per-feed activation
// timestamp, so activatedAt is null: a webhook-written row (with a real
// timestamp) always wins later via `on conflict do nothing`.
export function planCsvBackfill(
  header: string[],
  rows: string[][],
): CsvBackfillPlan {
  const emailIdx = header.indexOf(EMAIL_COL)
  if (emailIdx < 0) throw new Error(`CSV is missing the "${EMAIL_COL}" column`)
  const regIdx = header.indexOf(REG_TYPE_COL)

  const feedCols = new Map<number, FeedCols>()
  header.forEach((name, idx) => {
    const m = FEED_COL.exec(name)
    if (!m) return
    const feedId = Number(m[1])
    const entry = feedCols.get(feedId) ?? {}
    if (m[2] === 'subscribed') entry.sub = idx
    else entry.dl = idx
    feedCols.set(feedId, entry)
  })

  // Pass 1: which feeds does anyone actually gate? A column can exist for a
  // public/free show that no one subscribes to (the export carried an empty
  // one); excluding it keeps us from crediting a Spotify member with a feed
  // that isn't a real private entitlement.
  const privateFeeds = new Set<number>()
  for (const row of rows) {
    for (const [feedId, cols] of feedCols) {
      if (isDownloadActivated(row, cols)) privateFeeds.add(feedId)
    }
  }

  // Pass 2: seed one activation per (email, feed).
  const seeds = new Map<string, ActivationSeed>()
  const allEmails = new Set<string>()
  const activatedEmails = new Set<string>()
  let fromDownloads = 0
  let fromSpotify = 0

  // Adds a seed if this pair is new. Download signals are processed before
  // Spotify, so a pair a member both downloaded and streams is attributed to
  // the concrete download.
  const add = (email: string, feedId: number, via: 'download' | 'spotify') => {
    const key = pairKey(email, feedId)
    if (seeds.has(key)) return
    seeds.set(key, { email, feedId, activatedAt: null })
    if (via === 'download') fromDownloads++
    else fromSpotify++
    activatedEmails.add(email)
  }

  for (const row of rows) {
    const raw = (row[emailIdx] ?? '').trim()
    if (!raw) continue
    const email = normalizeEmail(raw)
    allEmails.add(email)

    for (const [feedId, cols] of feedCols) {
      if (isDownloadActivated(row, cols)) add(email, feedId, 'download')
    }

    const linkedSpotify =
      regIdx >= 0 && (row[regIdx] ?? '').trim().toLowerCase() === SPOTIFY
    if (linkedSpotify) {
      for (const feedId of privateFeeds) add(email, feedId, 'spotify')
    }
  }

  return {
    seeds: [...seeds.values()],
    feedsInExport: [...feedCols.keys()].sort((a, b) => a - b),
    privateFeeds: [...privateFeeds].sort((a, b) => a - b),
    fromDownloads,
    fromSpotify,
    membersSeen: allEmails.size,
    membersActivated: activatedEmails.size,
    membersNotActivated: allEmails.size - activatedEmails.size,
  }
}
