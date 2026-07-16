// Feed-setup reminder configuration — shared by the server (cron + admin route)
// and the client (admin form). The cron reads the live config from the DB
// (app_settings), falling back to env then these defaults.

export type ReminderConfig = {
  enabled: boolean
  // Minimum age since joining before a reminder goes out (so we don't nudge
  // someone mid-signup).
  delayHours: number
  // Maximum age: members who joined longer ago than this are left alone, so a
  // first run doesn't blast the entire back catalogue.
  windowDays: number
  // When true, remind only members who've set up ZERO feeds (the "never
  // started" cohort). When false, remind anyone with incomplete setup.
  onlyIfNoneSetUp: boolean
}

export const DEFAULT_REMINDER_CONFIG: ReminderConfig = {
  // Off by default: enabling requires an explicit opt-in (FEED_REMINDER_ENABLED
  // or the admin config). This makes the safe ordering the default — the
  // activation backfill must run first, otherwise members who set up their
  // feeds before webhook tracking existed read as "0 set up" and get a spurious
  // (one-time, irreversible) nudge on the cron's first run.
  enabled: false,
  delayHours: 24,
  windowDays: 14,
  onlyIfNoneSetUp: true,
}

// Bounds keep the admin form (and any env override) sane: a reminder that fires
// months after signup, or a window narrower than the delay (which no one could
// satisfy), is almost certainly a mistake.
export const REMINDER_LIMITS = {
  delayHoursMax: 2160, // 90 days
  windowDaysMax: 365,
} as const

// Validate an untrusted config object (admin PUT body). Returns the normalized
// config or a human-readable error. Pure — safe to run on client and server.
export function validateReminderConfig(
  input: unknown,
): { ok: true; value: ReminderConfig } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Expected a config object.' }
  }
  const o = input as Record<string, unknown>

  if (typeof o.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' }
  }
  if (typeof o.onlyIfNoneSetUp !== 'boolean') {
    return { ok: false, error: 'onlyIfNoneSetUp must be true or false.' }
  }

  const delayHours = o.delayHours
  if (
    typeof delayHours !== 'number' ||
    !Number.isInteger(delayHours) ||
    delayHours < 0 ||
    delayHours > REMINDER_LIMITS.delayHoursMax
  ) {
    return {
      ok: false,
      error: `delayHours must be a whole number between 0 and ${REMINDER_LIMITS.delayHoursMax}.`,
    }
  }

  const windowDays = o.windowDays
  if (
    typeof windowDays !== 'number' ||
    !Number.isInteger(windowDays) ||
    windowDays < 1 ||
    windowDays > REMINDER_LIMITS.windowDaysMax
  ) {
    return {
      ok: false,
      error: `windowDays must be a whole number between 1 and ${REMINDER_LIMITS.windowDaysMax}.`,
    }
  }

  // The window must be at least as long as the delay, or no member can ever be
  // both "old enough" and "recent enough" at once.
  if (windowDays * 24 < delayHours) {
    return {
      ok: false,
      error: 'The window (days) must be at least as long as the delay (hours).',
    }
  }

  return {
    ok: true,
    value: {
      enabled: o.enabled,
      delayHours,
      windowDays,
      onlyIfNoneSetUp: o.onlyIfNoneSetUp,
    },
  }
}
