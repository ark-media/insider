// Feed-setup reminder cron logic. Scans the premium readers we hold in Neon,
// finds those who started paying but haven't set up their private feed, and
// sends a one-time nudge via Resend. A ledger (feed_reminder_sends) prevents
// double-nagging.
//
// Addressing a reminder is the awkward part: `membership` is keyed on the Auth0
// sub and stores no email. The premium newsletter mirror
// (`beehiiv_subscription`) is what makes it possible — it is keyed on email,
// marks premium, and stamps `premium_since` (migration 0023) as the join
// clock.
//
// One premium show means `total` is always 1, so "partially set up" is not a
// state that exists any more: a member has either activated their feed or not,
// and `onlyIfNoneSetUp` collapses into that same question.
//
// The decision rules stay pure functions (memberInWindow / evaluateReminder) so
// they're unit-testable without the DB or email. The orchestrator wires those
// to the roster query, per-candidate activation/ledger lookups, and send.

import type { Sql } from './db.js'
import { premiumShowIds } from './beehiiv-feeds.js'
import { getActivatedFeeds, normalizeEmail } from './feed-activations.js'
import { mailableStatus } from './beehiiv-status.js'
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

// A premium reader we should not nudge — the shared Beehiiv rule, kept under
// this module's own name because the cron and its tests have always called it
// that. See lib/beehiiv-status.ts for the list, and for why an unknown status
// fails open.
export function memberStatusEligible(status: string | undefined): boolean {
  return mailableStatus(status)
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

// One premium reader, as the roster query returns them. Email and status come
// from the Beehiiv mirror, `joined` is `premium_since`, and the feed list is
// implicit (exactly one show).
export type PremiumReader = {
  email: string
  status?: string
  /** `premium_since` — when they became a paying member. */
  joined?: string
  firstName?: string
  lastName?: string
}

// A cheap pre-gate (status + window) so the orchestrator only hits the DB for
// members that could plausibly be reminded. Does NOT consider setup progress
// (that needs a DB read).
export function passesCheapGate(
  member: PremiumReader,
  config: ReminderConfig,
  nowMs: number,
): boolean {
  if (!config.enabled) return false
  if (!member.email?.trim()) return false
  if (!memberStatusEligible(member.status)) return false
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
  member: PremiumReader,
  activatedShowIds: Set<string>,
  alreadySent: boolean,
  config: ReminderConfig,
  nowMs: number,
  premiumShowIds: string[],
): ReminderCandidate | null {
  if (alreadySent) return null
  if (!passesCheapGate(member, config, nowMs)) return null
  // The counts the email actually says out loud ("2 of 4 set up"). They were
  // always carried on the candidate for this moment — a second premium show
  // landed, and neither the template nor the ledger had to change shape.
  const total = premiumShowIds.length
  if (total === 0) return null // nothing discovered to set up
  const doneCount = premiumShowIds.filter((id) => activatedShowIds.has(id)).length
  if (doneCount >= total) return null // fully set up
  return {
    email: normalizeEmail(member.email),
    // Names are only ever greeted through this guard: a name manufactured from
    // an email local part must never reach a salutation ("Hi hannah.waxman8,").
    firstName: greetingFirstName(member.firstName, member.email, member.lastName),
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

// The roster: premium readers inside the reminder window, straight from the
// mirror. Bounded by the window in SQL rather than loading the whole member
// base on every run and filtering in memory.
async function loadPremiumReaders(
  sql: Sql,
  config: ReminderConfig,
  nowMs: number,
): Promise<PremiumReader[]> {
  const oldest = new Date(nowMs - config.windowDays * 86_400_000).toISOString()
  const newest = new Date(nowMs - config.delayHours * 3_600_000).toISOString()
  const rows = (await sql`
    select email, status, premium_since
    from beehiiv_subscription
    where has_premium = true
      and premium_since is not null
      and premium_since >= ${oldest}
      and premium_since <= ${newest}`) as Array<{
    email: string
    status: string | null
    premium_since: string | null
  }>
  return rows.map((r) => ({
    email: r.email,
    status: r.status ?? undefined,
    joined: r.premium_since ?? undefined,
  }))
}

export async function runFeedSetupReminders(deps: {
  env: Env
  sql: Sql
  appBaseUrl: string
  config: ReminderConfig
  nowMs: number
}): Promise<ReminderRunSummary> {
  const { env, sql, appBaseUrl, config, nowMs } = deps
  if (!config.enabled) {
    return { enabled: false, scanned: 0, eligible: 0, sent: 0, failed: 0 }
  }

  const members = await loadPremiumReaders(sql, config, nowMs)
  // Which shows a member is expected to have set up. Discovered from Beehiiv
  // rather than configured, and any address will do — whether a show is premium
  // is a fact about the show, not about who asks. Resolved once per run; an
  // empty roster means nothing to count against and nothing to send.
  const premiumShows = members.length
    ? await premiumShowIds(env, members[0]!.email)
    : []
  // Members to serve but nothing to serve them: Beehiiv is unreachable or
  // misconfigured. Throw so the cron route 500s and the run is visible, rather
  // than reporting a successful zero — the old code failed loudly on a missing
  // show id and this is the same failure wearing different clothes.
  if (members.length > 0 && premiumShows.length === 0) {
    throw new Error('[feed-reminders] no premium shows discovered')
  }
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
      premiumShows,
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
