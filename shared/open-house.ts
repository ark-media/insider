// Open Houses — the drop-in sessions advertised on the public /fold page.
//
// One config blob in `app_settings`, edited in the back office rather than
// checked into code: the schedule moves (different times on different weeks, to
// reach different time zones) and every session carries its own Zoom link, so
// this is data the team edits, not something that should need a deploy.
//
// Pure module, shared three ways: the admin form validates against it before
// submitting, the PUT route validates the same untrusted body with it, and
// `upcomingOpenHouses` is the single place that decides which sessions a
// visitor is actually shown.

export type OpenHouseSession = {
  /** Stable id, minted by the admin form. Keys the list and survives reorders. */
  id: string
  /** When it starts, as an absolute UTC instant. */
  startsAt: string
  /** How long it runs — what keeps a session listed while it's in progress. */
  durationMinutes: number
  /**
   * Where RSVP points: the Zoom registration link.
   *
   * Optional on purpose. A date is usually settled before the meeting is
   * created, and announcing "October 14" is worth more than withholding it —
   * so a session without a link renders the date and says the link is coming,
   * rather than offering a button that goes nowhere.
   */
  rsvpUrl?: string
  /** One short line of context — "Evening session, for Europe and Israel". */
  note?: string
}

export type OpenHouseConfig = {
  /** Master switch. Off hides the whole section, whatever is scheduled. */
  enabled: boolean
  sessions: OpenHouseSession[]
}

/** How many upcoming sessions the /fold section lists at once. */
export const OPEN_HOUSE_DISPLAY_LIMIT = 3

const MAX_SESSIONS = 24
const MAX_NOTE_LENGTH = 120
const MIN_DURATION_MINUTES = 5
const MAX_DURATION_MINUTES = 480

export const DEFAULT_OPEN_HOUSE_CONFIG: OpenHouseConfig = {
  enabled: true,
  sessions: [
    {
      id: 'first-open-house',
      // Wednesday, October 14 2026 at 12:00 PM ET (16:00Z — EDT is UTC-4) —
      // the day the team named as the start of the series.
      //
      // PLACEHOLDER, both halves: the hour is a guess and there is no Zoom link
      // yet. Set them in /admin/open-houses before launch. Until a link is
      // added the card shows the date without an RSVP button, which is the
      // honest state rather than a dead CTA.
      startsAt: '2026-10-14T16:00:00.000Z',
      durationMinutes: 45,
    },
  ],
}

/**
 * The sessions a visitor should see: enabled, still to come, soonest first,
 * capped at `limit`.
 *
 * "Still to come" means the session hasn't *ended* — a session already under
 * way is exactly the one a late arrival is looking for, and dropping it at its
 * start time would hide it from them.
 */
export function upcomingOpenHouses(
  config: OpenHouseConfig,
  nowMs: number,
  limit: number = OPEN_HOUSE_DISPLAY_LIMIT,
): OpenHouseSession[] {
  if (!config.enabled) return []
  return config.sessions
    .filter((s) => {
      const startMs = Date.parse(s.startsAt)
      if (Number.isNaN(startMs)) return false
      return startMs + s.durationMinutes * 60_000 > nowMs
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, limit)
}

// --- Validation ----------------------------------------------------------

export type OpenHouseValidation =
  | { ok: true; value: OpenHouseConfig }
  | { ok: false; error: string }

// The RSVP link is rendered as an href on a public page, so only http(s) gets
// through — a `javascript:` or `data:` URL must never reach the markup.
function normalizeRsvpUrl(raw: unknown): string | undefined | { error: string } {
  if (raw == null || raw === '') return undefined
  if (typeof raw !== 'string') return { error: 'RSVP link must be a string.' }
  const value = raw.trim()
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'RSVP link must be an http(s) URL.' }
    }
    return value
  } catch {
    return { error: `"${value}" is not a valid URL.` }
  }
}

function validateSession(
  raw: unknown,
  index: number,
): { ok: true; value: OpenHouseSession } | { ok: false; error: string } {
  const where = `Session ${index + 1}`
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `${where} is not an object.` }
  }
  const r = raw as Record<string, unknown>

  const id = typeof r.id === 'string' ? r.id.trim() : ''
  if (!id) return { ok: false, error: `${where} is missing an id.` }

  if (typeof r.startsAt !== 'string') {
    return { ok: false, error: `${where} needs a date and time.` }
  }
  const startMs = Date.parse(r.startsAt)
  if (Number.isNaN(startMs)) {
    return { ok: false, error: `${where} has a date and time we can't read.` }
  }

  const duration = r.durationMinutes
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < MIN_DURATION_MINUTES ||
    duration > MAX_DURATION_MINUTES
  ) {
    return {
      ok: false,
      error: `${where}: length must be a whole number of minutes, ${MIN_DURATION_MINUTES}–${MAX_DURATION_MINUTES}.`,
    }
  }

  const rsvpUrl = normalizeRsvpUrl(r.rsvpUrl)
  if (rsvpUrl !== undefined && typeof rsvpUrl === 'object') {
    return { ok: false, error: `${where}: ${rsvpUrl.error}` }
  }

  let note: string | undefined
  if (r.note != null && r.note !== '') {
    if (typeof r.note !== 'string') {
      return { ok: false, error: `${where}: note must be text.` }
    }
    note = r.note.trim().slice(0, MAX_NOTE_LENGTH)
    if (!note) note = undefined
  }

  // Normalized rather than echoed back: the instant is re-serialized so every
  // stored row is the same ISO shape, whatever the form sent.
  return {
    ok: true,
    value: {
      id,
      startsAt: new Date(startMs).toISOString(),
      durationMinutes: duration,
      ...(rsvpUrl ? { rsvpUrl } : {}),
      ...(note ? { note } : {}),
    },
  }
}

/** Validate an untrusted config object (the admin PUT body). Pure. */
export function validateOpenHouseConfig(input: unknown): OpenHouseValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Expected a config object.' }
  }
  const o = input as Record<string, unknown>

  if (typeof o.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be true or false.' }
  }
  if (!Array.isArray(o.sessions)) {
    return { ok: false, error: 'sessions must be a list.' }
  }
  if (o.sessions.length > MAX_SESSIONS) {
    return { ok: false, error: `No more than ${MAX_SESSIONS} sessions.` }
  }

  const sessions: OpenHouseSession[] = []
  const seen = new Set<string>()
  for (const [i, raw] of o.sessions.entries()) {
    const v = validateSession(raw, i)
    if (!v.ok) return v
    if (seen.has(v.value.id)) {
      return { ok: false, error: `Session ${i + 1} repeats an id.` }
    }
    seen.add(v.value.id)
    sessions.push(v.value)
  }

  return { ok: true, value: { enabled: o.enabled, sessions } }
}
