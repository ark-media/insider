// Feed-setup reminder cron logic. Pages the SC membership roster (both
// checkout-provisioned and bulk-migrated members), finds those who joined but
// haven't finished setting up their private feeds, and sends a one-time nudge
// via Resend. A ledger (feed_reminder_sends) prevents double-nagging.
//
// The decision rules are pure functions (memberInWindow / evaluateReminder) so
// they're unit-testable without SC, the DB, or email. The orchestrator wires
// those to the roster load, per-candidate activation/ledger lookups, and send.

import type { Sql } from './db.js'
import {
  loadAllMemberships,
  type ScMembership,
  type ScV1Client,
} from './sc-client.js'
import { getActivatedFeeds, normalizeEmail } from './feed-activations.js'
import { renderFeedReminderEmail } from './feed-reminder-email.js'
import { greetingFirstName } from '../../shared/profile-name.js'
import { sendEmail } from './email.js'
import {
  DEFAULT_REMINDER_CONFIG,
  type ReminderConfig,
} from '../../shared/feed-reminder.js'

type Env = Record<string, string>

export { DEFAULT_REMINDER_CONFIG }
export type { ReminderConfig }

// Env-override layer on top of the code defaults. This is the fallback the
// admin-set config (app_settings) is resolved against — see
// getReminderConfig in app-settings.ts.
export function loadReminderConfigFromEnv(env: Env): ReminderConfig {
  const d = DEFAULT_REMINDER_CONFIG
  const num = (key: string, fallback: number) => {
    const raw = env[key]
    if (raw === undefined || raw.trim() === '') return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  return {
    enabled: env.FEED_REMINDER_ENABLED
      ? env.FEED_REMINDER_ENABLED !== 'false'
      : d.enabled,
    delayHours: num('FEED_REMINDER_DELAY_HOURS', d.delayHours),
    windowDays: num('FEED_REMINDER_WINDOW_DAYS', d.windowDays),
    onlyIfNoneSetUp: env.FEED_REMINDER_ONLY_IF_NONE
      ? env.FEED_REMINDER_ONLY_IF_NONE !== 'false'
      : d.onlyIfNoneSetUp,
  }
}

// SC statuses that mean the member has no live access — never remind these.
// Lowercased; unknown/blank statuses are treated as eligible (fail-open, since
// the join-window gate already scopes to recent members).
const SKIP_STATUSES = new Set([
  'cancelled',
  'canceled',
  'expired',
  'refunded',
  'inactive',
  'disabled',
  'deleted',
  'suspended',
])

export function memberStatusEligible(status: string | undefined): boolean {
  if (!status) return true
  return !SKIP_STATUSES.has(status.trim().toLowerCase())
}

// Did this member join inside the reminder window — old enough to have had a
// chance to set up (delayHours), but not so old we've missed the boat
// (windowDays)?
export function memberInWindow(
  joined: string | undefined,
  config: ReminderConfig,
  nowMs: number,
): boolean {
  if (!joined) return false
  const joinedMs = Date.parse(joined)
  if (Number.isNaN(joinedMs)) return false
  const age = nowMs - joinedMs
  const minAge = config.delayHours * 3_600_000
  const maxAge = config.windowDays * 86_400_000
  return age >= minAge && age <= maxAge
}

// A cheap pre-gate (status + has-feeds + window) so the orchestrator only hits
// the DB for members that could plausibly be reminded. Does NOT consider setup
// progress (that needs a DB read).
export function passesCheapGate(
  member: ScMembership,
  config: ReminderConfig,
  nowMs: number,
): boolean {
  if (!config.enabled) return false
  if (!member.email?.trim()) return false
  if (!memberStatusEligible(member.status)) return false
  if ((member.feeds?.length ?? 0) === 0) return false
  return memberInWindow(member.joined, config, nowMs)
}

export type ReminderCandidate = {
  email: string
  firstName?: string
  doneCount: number
  total: number
}

// The full decision, given a member's setup state. Returns the candidate to
// email, or null to skip. Re-applies the cheap gate so it's a single source of
// truth (the orchestrator's pre-gate is just an optimization).
export function evaluateReminder(
  member: ScMembership,
  activatedFeedIds: Set<number>,
  alreadySent: boolean,
  config: ReminderConfig,
  nowMs: number,
): ReminderCandidate | null {
  if (alreadySent) return null
  if (!passesCheapGate(member, config, nowMs)) return null
  const feeds = member.feeds ?? []
  const total = feeds.length
  const doneCount = feeds.reduce(
    (n, f) => n + (activatedFeedIds.has(f.id) ? 1 : 0),
    0,
  )
  if (doneCount >= total) return null // fully set up
  if (config.onlyIfNoneSetUp && doneCount > 0) return null
  return {
    email: normalizeEmail(member.email),
    // Supporting Cast's first_name is manufactured from the email local part
    // whenever we created the user without a name (findOrCreateScUser), so it
    // can't be greeted with directly — that's how "Hi hannah.waxman8," ships.
    firstName: greetingFirstName(member.first_name, member.email, member.last_name),
    doneCount,
    total,
  }
}

// --- ledger ---------------------------------------------------------------

async function hasReminderBeenSent(
  sql: Sql,
  email: string,
  reminderNo = 1,
): Promise<boolean> {
  const rows = (await sql`
    select 1 from feed_reminder_sends
    where email = ${normalizeEmail(email)} and reminder_no = ${reminderNo}
    limit 1`) as unknown[]
  return rows.length > 0
}

async function recordReminderSent(
  sql: Sql,
  email: string,
  doneCount: number,
  total: number,
  reminderNo = 1,
): Promise<void> {
  await sql`
    insert into feed_reminder_sends (email, reminder_no, done_count, total_count)
    values (${normalizeEmail(email)}, ${reminderNo}, ${doneCount}, ${total})
    on conflict (email, reminder_no) do nothing`
}

// --- orchestrator ---------------------------------------------------------

export type ReminderRunSummary = {
  enabled: boolean
  scanned: number
  eligible: number
  sent: number
  failed: number
}

export async function runFeedSetupReminders(deps: {
  env: Env
  sql: Sql
  sc: ScV1Client
  appBaseUrl: string
  config: ReminderConfig
  nowMs: number
}): Promise<ReminderRunSummary> {
  const { env, sql, sc, appBaseUrl, config, nowMs } = deps
  if (!config.enabled) {
    return { enabled: false, scanned: 0, eligible: 0, sent: 0, failed: 0 }
  }

  const members = await loadAllMemberships(sc)
  const setupUrl = `${appBaseUrl}/account/podcast-feed`
  let eligible = 0
  let sent = 0
  let failed = 0

  for (const member of members) {
    // Cheap gate first — avoids a DB round-trip for the (large) majority not in
    // the reminder window.
    if (!passesCheapGate(member, config, nowMs)) continue

    const email = normalizeEmail(member.email)
    const alreadySent = await hasReminderBeenSent(sql, email)
    if (alreadySent) continue

    const activated = new Set((await getActivatedFeeds(sql, email)).keys())
    const candidate = evaluateReminder(
      member,
      activated,
      alreadySent,
      config,
      nowMs,
    )
    if (!candidate) continue
    eligible++

    const { subject, html } = renderFeedReminderEmail({
      firstName: candidate.firstName,
      doneCount: candidate.doneCount,
      total: candidate.total,
      setupUrl,
    })
    const ok = await sendEmail(env, { to: candidate.email, subject, html })
    if (ok) {
      await recordReminderSent(sql, email, candidate.doneCount, candidate.total)
      sent++
    } else {
      // Soft-fail: leave the ledger untouched so the next run retries this
      // member rather than silently dropping them.
      failed++
    }
  }

  return { enabled: true, scanned: members.length, eligible, sent, failed }
}
