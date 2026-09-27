// Win-back cron logic. Scans the cancellation record for members who left
// around 180 days ago, drops anyone who has since come back or opted out, and
// sends a one-time invitation to resubscribe: the Ark+ email to anyone who left
// a tier with Ark+ in it, the Fold email to anyone who left the Fold on its own.
// A ledger (winback_sends) prevents double-mailing.
//
// The roster is `cancellation_survey`, not `membership`: a member who cancelled
// has no membership row (subscription.deleted deletes it), and the survey row is
// exactly the durable, email-keyed record that outlives it — which is what
// its `canceled_tier` / `retained_product` columns are for.
//
// Three things disqualify a candidate, and they are checked in that order
// because each is cheaper than the next:
//
//   1. Opted out of this campaign (winback_suppression).
//   2. Already mailed for this cohort (winback_sends).
//   3. Already back. For Ark+, `beehiiv_subscription.has_premium`, the same
//      email-keyed premium mirror the feed reminders read. For the Fold, which
//      Beehiiv knows nothing about, a live Fold axis on any membership row for
//      the address (isOnFold, via Auth0 — `membership` stores no email).
//
// The decision core (candidateFor) is a pure function so the rules are
// unit-testable without the DB or email. The orchestrator wires it to the
// roster query, the per-candidate lookups, and the send.

import type { Sql } from './db.js'
import { normalizeEmail } from './feed-activations.js'
import { mailableStatus } from './beehiiv-status.js'
import { renderFoldWinbackEmail, renderWinbackEmail } from './winback-email.js'
import { sendEmail } from './email.js'

type Env = Record<string, string>

// Which email a leaver gets. Stored on every ledger row (as the cohort) so the
// two campaigns, or a second horizon later (a 30-day nudge, say), never collide.
type WinbackCampaign = 'ark_plus' | 'fold'
const WINBACK_COHORT: Record<WinbackCampaign, string> = {
  ark_plus: 'ark_plus_180d',
  fold: 'fold_180d',
}
const RENDER: Record<WinbackCampaign, typeof renderWinbackEmail> = {
  ark_plus: renderWinbackEmail,
  fold: renderFoldWinbackEmail,
}

// How long after cancelling the invitation goes out. The doc's copy says "six
// months" out loud, so this number and that sentence have to move together.
export const WINBACK_AFTER_DAYS = 180

// How far past the 180-day mark someone stays eligible. Without it, the cron's
// first run would mail every member who ever cancelled — and a run that is
// skipped (a deploy, an outage) would silently drop everyone whose day it was.
// 30 days is wide enough to absorb both and narrow enough that nobody hears
// "it's been six months" nine months later.
const WINBACK_WINDOW_DAYS = 30

// Which email a full exit gets, by the tier they left. The Ark+ copy speaks
// entirely about Ark+ ("since you left Ark+", ad-free listening, early access),
// so a Fold-only canceller gets the Fold email instead — never one inviting them
// back to something they never had. A Bundle leaver lost both and gets the Ark+
// one: one win-back per person.
function campaignFor(row: Pick<WinbackRow, 'canceled_tier' | 'retained_product'>): WinbackCampaign | null {
  // A debundle keeps a product: someone who dropped the Fold is still an Ark+
  // member (Hannah, 2026-09-27: no Fold win-back for them — that would be an
  // upsell to a customer), and someone who dropped Ark+ never "left Ark+" in
  // the sense the copy means. Only a full exit qualifies.
  if (row.retained_product !== 'full-exit') return null
  if (row.canceled_tier === 'ark-plus' || row.canceled_tier === 'bundle') return 'ark_plus'
  if (row.canceled_tier === 'circle') return 'fold'
  return null
}

// One cancellation, as the roster query returns it.
export type WinbackRow = {
  email: string
  canceled_tier: string | null
  retained_product: string | null
  /** Beehiiv mirror, left-joined: null when we hold no record for the address. */
  has_premium: boolean | null
  status: string | null
}

export type WinbackCandidate = { email: string; campaign: WinbackCampaign }

// The full decision for one row, given what the per-candidate lookups found.
// Returns the candidate to mail, or null to skip.
export function candidateFor(
  row: WinbackRow,
  opts: { suppressed: boolean; alreadySent: boolean; onFold?: boolean },
): WinbackCandidate | null {
  if (opts.suppressed) return null
  if (opts.alreadySent) return null
  if (!row.email?.trim()) return null
  const campaign = campaignFor(row)
  if (!campaign) return null
  // Already back. `has_premium` is the live premium mirror; a null means we hold
  // no Beehiiv record at all, which is not evidence of a live membership. It
  // also stops a Fold leaver who has since taken Ark+ being pitched the Fold
  // cold: they're a customer again.
  if (row.has_premium === true) return null
  if (campaign === 'fold' && opts.onFold) return null
  if (!mailableStatus(row.status)) return null
  return { email: normalizeEmail(row.email), campaign }
}

// --- ledger ---------------------------------------------------------------

async function isSuppressed(sql: Sql, email: string): Promise<boolean> {
  const rows = (await sql`
    select 1 from winback_suppression where email = ${normalizeEmail(email)} limit 1`) as unknown[]
  return rows.length > 0
}

async function hasBeenSent(sql: Sql, email: string, cohort: string): Promise<boolean> {
  const rows = (await sql`
    select 1 from winback_sends
    where email = ${normalizeEmail(email)} and cohort = ${cohort}
    limit 1`) as unknown[]
  return rows.length > 0
}

async function recordSent(sql: Sql, email: string, cohort: string): Promise<void> {
  await sql`
    insert into winback_sends (email, cohort)
    values (${normalizeEmail(email)}, ${cohort})
    on conflict (email, cohort) do nothing`
}

export async function suppressWinback(sql: Sql, email: string): Promise<void> {
  await sql`
    insert into winback_suppression (email)
    values (${normalizeEmail(email)})
    on conflict (email) do nothing`
}

// --- orchestrator ---------------------------------------------------------

export type WinbackRunSummary = {
  scanned: number
  eligible: number
  sent: number
  failed: number
}

// The roster: full exits (from any tier) whose cancellation lands
// inside the eligibility window. Bounded in SQL rather than loading every
// cancellation ever recorded and filtering in memory. The Beehiiv mirror is
// LEFT joined so an address we hold no record for still comes back (and is then
// treated as mailable — the window gate already scopes this tightly).
async function loadRoster(
  sql: Sql,
  nowMs: number,
): Promise<WinbackRow[]> {
  const newest = new Date(nowMs - WINBACK_AFTER_DAYS * 86_400_000).toISOString()
  const oldest = new Date(
    nowMs - (WINBACK_AFTER_DAYS + WINBACK_WINDOW_DAYS) * 86_400_000,
  ).toISOString()
  const rows = (await sql`
    select cs.email,
           cs.canceled_tier,
           cs.retained_product,
           bs.has_premium,
           bs.status
    from cancellation_survey cs
    left join beehiiv_subscription bs on lower(bs.email) = lower(cs.email)
    where cs.retained_product = 'full-exit'
      and cs.created_at >= ${oldest}
      and cs.created_at <= ${newest}`) as WinbackRow[]
  return rows
}

export async function runWinbackCampaign(deps: {
  env: Env
  sql: Sql
  appBaseUrl: string
  nowMs: number
  /** Builds the per-recipient unsubscribe link (signed; see routes/winback.ts). */
  unsubscribeUrlFor: (email: string) => string
  /** The greeting name for an address, when we can resolve one. */
  firstNameFor?: (email: string) => Promise<string | undefined>
  /**
   * Whether the address holds the Fold again. Asked only for a Fold leaver who
   * is otherwise due an email. May throw: that leaver is skipped this run and
   * retried the next, never mailed on a guess.
   */
  isOnFold: (email: string) => Promise<boolean>
}): Promise<WinbackRunSummary> {
  const { env, sql, appBaseUrl, nowMs, unsubscribeUrlFor, firstNameFor, isOnFold } = deps

  const rows = await loadRoster(sql, nowMs)
  const rejoinUrl: Record<WinbackCampaign, string> = {
    ark_plus: `${appBaseUrl}/plus`,
    fold: `${appBaseUrl}/fold`,
  }
  let eligible = 0
  let sent = 0
  let failed = 0

  // One address can hold several cancellation rows (cancel, resubscribe,
  // cancel again). The ledger would collapse them anyway — after the first
  // send — but only after paying for the lookups, and the second row would
  // still be counted as eligible. Collapse here instead.
  const seen = new Set<string>()

  for (const row of rows) {
    const email = normalizeEmail(row.email ?? '')
    if (!email || seen.has(email)) continue
    seen.add(email)

    const campaign = campaignFor(row)
    if (!campaign) continue
    const cohort = WINBACK_COHORT[campaign]

    const suppressed = await isSuppressed(sql, email)
    const alreadySent = suppressed ? false : await hasBeenSent(sql, email, cohort)
    // The Fold check costs an Auth0 call, so it runs last and only for someone
    // who'd otherwise be mailed.
    let onFold = false
    if (campaign === 'fold' && !suppressed && !alreadySent && row.has_premium !== true) {
      try {
        onFold = await isOnFold(email)
      } catch (err) {
        console.error('[winback] Fold membership check failed; retrying next run:', err)
        failed++
        continue
      }
    }
    const candidate = candidateFor(row, { suppressed, alreadySent, onFold })
    if (!candidate) continue
    eligible++

    const { subject, html } = RENDER[campaign]({
      firstName: await firstNameFor?.(candidate.email),
      rejoinUrl: rejoinUrl[campaign],
      unsubscribeUrl: unsubscribeUrlFor(candidate.email),
    })
    const ok = await sendEmail(env, {
      to: candidate.email,
      subject,
      html,
      // Keyed on the cohort so a cron that runs twice in a day — a manual
      // trigger alongside the schedule — collapses to one delivery even before
      // the ledger write lands.
      idempotencyKey: `winback_${cohort}_${candidate.email}`,
    })
    if (ok) {
      await recordSent(sql, email, cohort)
      sent++
    } else {
      // Soft-fail: leave the ledger untouched so the next run retries this
      // member rather than silently dropping them.
      failed++
    }
  }

  return { scanned: rows.length, eligible, sent, failed }
}
