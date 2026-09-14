// The feed-migration check-in campaign — configuration and its clock.
//
// This is a DIFFERENT campaign from the feed-setup reminder in
// ./feed-reminder.ts, and the difference is what each one counts from:
//
//   feed-reminder   counts from the member's own join date. "You just joined
//                   and haven't set up a feed." One send, in the first fortnight.
//
//   feed-migration  counts from two fixed calendar dates — the day Ark+ launched
//                   and the day the old feed is switched off. "It's been 60 days
//                   since launch and you still haven't moved." Three sends,
//                   escalating, addressed to the members who were carried over
//                   from the old feed rather than to everyone who joins.
//
// They are sequential rather than competing: the reminder fires inside the first
// 14 days, the first check-in at day 30. A member who ignores all of it gets a
// nudge, then two check-ins, then a final notice — an escalation ladder, not
// four copies of one email.
//
// Pure and shared so the cron, the admin form, and the validator on the route
// all read the same rules.

export type MigrationStage = 'check_in_30' | 'check_in_60' | 'final'

// Position in the ledger (`feed_reminder_sends.reminder_no`), which the
// feed-setup reminder already uses with 1. Numbering them here rather than at
// the call sites is what keeps the two campaigns from colliding on a row.
export const MIGRATION_REMINDER_NO: Record<MigrationStage, number> = {
  check_in_30: 2,
  check_in_60: 3,
  final: 4,
}

export type MigrationConfig = {
  enabled: boolean
  /**
   * Calendar date (YYYY-MM-DD) Ark+ launched — what the two check-ins count
   * from, and the cutoff that defines the cohort: a member whose premium
   * access predates the end of this day was carried over from the old feed.
   * Someone who subscribed afterwards never had one to migrate.
   */
  launchDate: string
  /** Calendar date (YYYY-MM-DD) the old feed is switched off. */
  deadlineDate: string
  /** Days after launch for the first check-in. */
  firstCheckInDays: number
  /** Days after launch for the second check-in. */
  secondCheckInDays: number
  /** Days before the deadline for the final notice. */
  finalNoticeDays: number
}

export const DEFAULT_MIGRATION_CONFIG: MigrationConfig = {
  enabled: true,
  // The day Ark+ launched to members — confirmed, not the Beehiiv deploy date
  // it was first guessed from. Everything about the campaign hangs off it: both
  // check-ins count from here, and it is the cutoff that decides who is in the
  // cohort at all (premium access predating the end of this day = carried over
  // from the old feed). Moving it moves all three sends.
  launchDate: '2026-10-05',
  // "Your old Call Me Back feed will be turned off at the end of 2026" — the
  // campaign copy states this date to members, so the two move together.
  deadlineDate: '2026-12-31',
  firstCheckInDays: 30,
  secondCheckInDays: 60,
  finalNoticeDays: 5,
}

const MIGRATION_LIMITS = {
  checkInDaysMax: 365,
  finalNoticeDaysMax: 90,
} as const

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Midnight UTC on a calendar date, as epoch ms. Null for anything that isn't a
 * real date.
 *
 * UTC rather than a named zone on purpose: these are calendar dates, not
 * instants, and the campaign's resolution is a day. Anchoring them in UTC means
 * a stage's due date is the same date everywhere, which is the property the
 * admin form and the copy both assume. The one place the reader's zone actually
 * matters — "in N days, on December 31" — is counted separately, in
 * EMAIL_TIME_ZONE, by the orchestrator.
 */
export function calendarDateMs(value: string): number | null {
  if (!CALENDAR_DATE.test(value)) return null
  const ms = Date.parse(`${value}T00:00:00Z`)
  if (Number.isNaN(ms)) return null
  // Round-trip so Feb 30 and friends are rejected rather than rolled forward.
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null
}

const DAY_MS = 86_400_000

export type StageSchedule = { stage: MigrationStage; dueMs: number }

/**
 * When each stage fires, earliest first. Empty when the config's dates don't
 * parse — the caller treats that as "campaign not runnable" rather than
 * guessing at a schedule.
 */
export function migrationSchedule(config: MigrationConfig): StageSchedule[] {
  const launch = calendarDateMs(config.launchDate)
  const deadline = calendarDateMs(config.deadlineDate)
  if (launch === null || deadline === null) return []
  const schedule: StageSchedule[] = [
    { stage: 'check_in_30', dueMs: launch + config.firstCheckInDays * DAY_MS },
    { stage: 'check_in_60', dueMs: launch + config.secondCheckInDays * DAY_MS },
    { stage: 'final', dueMs: deadline - config.finalNoticeDays * DAY_MS },
  ]
  return schedule.sort((a, b) => a.dueMs - b.dueMs)
}

/**
 * The stage a member is owed right now, or null when the campaign isn't running.
 *
 * Returns the LATEST stage that has come due — never a backlog. If the cron is
 * down through the 30-day mark and first runs on day 65, the member gets the
 * 60-day email, not both: the later one is the accurate description of where
 * they actually are, and sending the pair on one morning reads as a mistake.
 *
 * Nothing fires once the deadline has passed. "Five days left" in January is
 * worse than silence, and by then the thing the campaign was protecting is gone.
 */
export function dueStage(
  config: MigrationConfig,
  nowMs: number,
): MigrationStage | null {
  if (!config.enabled) return null
  const deadline = calendarDateMs(config.deadlineDate)
  if (deadline === null) return null
  if (nowMs > deadline + DAY_MS) return null

  let due: MigrationStage | null = null
  for (const s of migrationSchedule(config)) {
    if (s.dueMs <= nowMs) due = s.stage
  }
  return due
}

/** Validate an untrusted config object (the admin PUT body). Pure. */
export function validateMigrationConfig(
  input: unknown,
): { ok: true; value: MigrationConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Expected a config object.' }
  }
  const o = input as Record<string, unknown>

  if (typeof o.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' }
  }

  for (const key of ['launchDate', 'deadlineDate'] as const) {
    const v = o[key]
    if (typeof v !== 'string' || calendarDateMs(v) === null) {
      return { ok: false, error: `${key} must be a date in YYYY-MM-DD form.` }
    }
  }
  const launch = calendarDateMs(o.launchDate as string)!
  const deadline = calendarDateMs(o.deadlineDate as string)!
  if (deadline <= launch) {
    return { ok: false, error: 'deadlineDate must be after launchDate.' }
  }

  const nums: Array<[keyof MigrationConfig, number]> = []
  for (const [key, max] of [
    ['firstCheckInDays', MIGRATION_LIMITS.checkInDaysMax],
    ['secondCheckInDays', MIGRATION_LIMITS.checkInDaysMax],
    ['finalNoticeDays', MIGRATION_LIMITS.finalNoticeDaysMax],
  ] as const) {
    const v = o[key]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
      return { ok: false, error: `${key} must be a whole number of days, 0–${max}.` }
    }
    nums.push([key, v])
  }
  const value = {
    enabled: o.enabled,
    launchDate: o.launchDate as string,
    deadlineDate: o.deadlineDate as string,
    ...Object.fromEntries(nums),
  } as MigrationConfig

  if (value.secondCheckInDays <= value.firstCheckInDays) {
    return {
      ok: false,
      error: 'secondCheckInDays must be later than firstCheckInDays.',
    }
  }
  // A final notice that lands before the second check-in would deliver the
  // stages out of order — the campaign would escalate and then de-escalate.
  const finalAt = deadline - value.finalNoticeDays * DAY_MS
  if (finalAt <= launch + value.secondCheckInDays * DAY_MS) {
    return {
      ok: false,
      error:
        'The final notice would land before the second check-in. Move the deadline out, or shorten the check-in offsets.',
    }
  }

  return { ok: true, value }
}
