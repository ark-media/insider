// Feed-migration check-in cron logic. Scans the members carried over from the
// old Call Me Back feed, finds the ones who still haven't set up their new Ark+
// feed, and sends whichever stage of the escalating series they are owed.
//
// Shares the ledger (`feed_reminder_sends`) and the activation lookup with the
// feed-setup reminder, and differs from it in exactly two ways — see the header
// of shared/feed-migration.ts:
//
//   * The clock is two fixed calendar dates, not the member's join date.
//   * The cohort is the members who HAD an old feed: premium access that
//     predates the end of launch day. Someone who subscribed afterwards has
//     nothing to migrate and must never be told they're behind on it.
//
// One stage per member per run at most, and never a backlog — dueStage() returns
// the latest stage that has come due, so a cron outage doesn't deliver two
// emails on one morning.
//
// The decision core lives in shared/feed-migration.ts (pure, unit-tested
// without the DB); this wires it to the roster query, the per-candidate
// activation and ledger lookups, and the send.

import type { Sql } from './db.js'
import { premiumShowIds } from './beehiiv-feeds.js'
import { getActivatedFeeds, normalizeEmail } from './feed-activations.js'
import { mailableStatus } from './beehiiv-status.js'
import { renderMigrationCheckInEmail } from './feed-migration-email.js'
import { greetingFirstName } from '../../shared/profile-name.js'
import { sendEmail } from './email.js'
import {
  EMAIL_TIME_ZONE,
  calendarDaysUntilInZone,
  formatCalendarDate,
} from '../../shared/format-date.js'
import {
  MIGRATION_REMINDER_NO,
  calendarDateMs,
  dueStage,
  type MigrationConfig,
  type MigrationStage,
} from '../../shared/feed-migration.js'

type Env = Record<string, string>

// One migrated member, as the roster query returns them.
type MigrationReader = {
  email: string
  status?: string
  firstName?: string
  lastName?: string
}

export type MigrationRunSummary = {
  enabled: boolean
  stage: MigrationStage | null
  scanned: number
  eligible: number
  sent: number
  failed: number
}

const DAY_MS = 86_400_000

// The cohort: premium readers whose access predates the END of launch day, i.e.
// everyone who was already a member when the feed moved. `premium_since` is
// stamped at migration, so the whole carried-over roster lands on launch day
// itself — which is why this is an end-of-day bound and not a strict `<`.
async function loadMigratedReaders(
  sql: Sql,
  config: MigrationConfig,
): Promise<MigrationReader[]> {
  const launchMs = calendarDateMs(config.launchDate)
  if (launchMs === null) return []
  const cutoff = new Date(launchMs + DAY_MS).toISOString()
  const rows = (await sql`
    select email, status
    from beehiiv_subscription
    where has_premium = true
      and premium_since is not null
      and premium_since < ${cutoff}`) as Array<{
    email: string
    status: string | null
  }>
  return rows.map((r) => ({ email: r.email, status: r.status ?? undefined }))
}

async function stageAlreadySent(
  sql: Sql,
  email: string,
  reminderNo: number,
): Promise<boolean> {
  const rows = (await sql`
    select 1 from feed_reminder_sends
    where email = ${normalizeEmail(email)} and reminder_no = ${reminderNo}
    limit 1`) as unknown[]
  return rows.length > 0
}

async function recordStageSent(
  sql: Sql,
  email: string,
  reminderNo: number,
  doneCount: number,
  total: number,
): Promise<void> {
  await sql`
    insert into feed_reminder_sends (email, reminder_no, done_count, total_count)
    values (${normalizeEmail(email)}, ${reminderNo}, ${doneCount}, ${total})
    on conflict (email, reminder_no) do nothing`
}

export async function runFeedMigrationReminders(deps: {
  env: Env
  sql: Sql
  appBaseUrl: string
  config: MigrationConfig
  nowMs: number
  /** Resolves a greeting name for an address, when one is held. */
  firstNameFor?: (email: string) => Promise<
    { firstName?: string; lastName?: string } | null
  >
}): Promise<MigrationRunSummary> {
  const { env, sql, appBaseUrl, config, nowMs, firstNameFor } = deps

  const stage = dueStage(config, nowMs)
  const idle = { scanned: 0, eligible: 0, sent: 0, failed: 0 }
  if (!config.enabled) return { enabled: false, stage: null, ...idle }
  // No stage has come due yet, or the deadline has passed and the campaign is
  // over. Either way there is nothing to say, so don't even load the roster.
  if (!stage) return { enabled: true, stage: null, ...idle }

  const reminderNo = MIGRATION_REMINDER_NO[stage]
  const readers = await loadMigratedReaders(sql, config)
  // The premium set, discovered once per run — see runFeedSetupReminders.
  const premiumShows = readers.length
    ? await premiumShowIds(env, readers[0]!.email ?? '')
    : []
  // See runFeedSetupReminders: nothing discovered while there are readers to
  // chase means the run is broken, and a silent zero would hide it.
  if (readers.length > 0 && premiumShows.length === 0) {
    throw new Error('[feed-migration] no premium shows discovered')
  }
  const setupUrl = `${appBaseUrl}/setup`
  // The deadline reads as a calendar date — it is a date we chose, not an
  // instant, so it must render identically in every reader's zone. The
  // countdown beside it is counted in EMAIL_TIME_ZONE so the two agree.
  const deadline = formatCalendarDate(config.deadlineDate, 'long')
  const daysRemaining =
    calendarDaysUntilInZone(
      `${config.deadlineDate}T00:00:00Z`,
      nowMs,
      EMAIL_TIME_ZONE,
    ) ?? 0

  let eligible = 0
  let sent = 0
  let failed = 0

  for (const reader of readers) {
    if (!reader.email?.trim()) continue
    if (!mailableStatus(reader.status)) continue

    const email = normalizeEmail(reader.email)
    if (await stageAlreadySent(sql, email, reminderNo)) continue

    // Still unset? The whole campaign is addressed to people who haven't
    // finished, so this is the last and most important gate. ANY premium show
    // in a podcast app proves they have moved off the old feed — which is what
    // this campaign asks for — so one is enough to stop writing to them.
    const activated = new Set((await getActivatedFeeds(sql, email)).keys())
    if (premiumShows.some((id) => activated.has(id))) continue
    eligible++

    const name = await firstNameFor?.(email)
    const { subject, html } = renderMigrationCheckInEmail({
      firstName: greetingFirstName(name?.firstName, email, name?.lastName),
      stage,
      setupUrl,
      deadline,
      daysRemaining,
    })
    const ok = await sendEmail(env, {
      to: email,
      subject,
      html,
      // Keyed on the stage so a cron that runs twice in a day collapses, while
      // the next stage still reaches the same member later.
      idempotencyKey: `feed_migration_${stage}_${email}`,
    })
    if (ok) {
      await recordStageSent(sql, email, reminderNo, 0, 1)
      sent++
    } else {
      // Soft-fail: leave the ledger untouched so the next run retries this
      // member rather than silently dropping them.
      failed++
    }
  }

  return { enabled: true, stage, scanned: readers.length, eligible, sent, failed }
}
