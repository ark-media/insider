// Help-widget session log: validation plus thin DB accessors.
//
// Same split as server/lib/faqs.ts — pure validation (unit-tested with plain
// objects) and accessors over `Sql`.

import type { Sql } from './db.js'
import {
  SUPPORT_MAX_SESSION_ID_LENGTH,
  SUPPORT_MAX_STEPS,
  SUPPORT_MAX_VALUE_LENGTH,
  SUPPORT_STEP_KINDS,
  type SupportSession,
  type SupportSessionInput,
  type SupportStep,
  type SupportStepKind,
} from '../../shared/support.js'

export type { SupportSession, SupportSessionInput }

const KINDS = new Set<string>(SUPPORT_STEP_KINDS)
// Client-generated, so treat it as opaque and constrain it hard: it is a
// primary lookup key and ends up in log lines.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,}$/

export type ValidationResult =
  | { ok: true; value: SupportSessionInput }
  | { ok: false; error: string }

/**
 * Validates a session payload. Every field is attacker-controlled: the endpoint
 * is public, so this caps step count and value length rather than trusting the
 * client's own limits, and drops unknown step kinds instead of storing them.
 */
export function validateSupportSession(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'invalid_body' }
  }
  const r = raw as Record<string, unknown>

  const sessionId = typeof r.sessionId === 'string' ? r.sessionId.trim() : ''
  if (
    !SESSION_ID_RE.test(sessionId) ||
    sessionId.length > SUPPORT_MAX_SESSION_ID_LENGTH
  ) {
    return { ok: false, error: 'invalid_session_id' }
  }

  if (!Array.isArray(r.steps)) return { ok: false, error: 'invalid_steps' }
  if (r.steps.length > SUPPORT_MAX_STEPS) {
    return { ok: false, error: 'too_many_steps' }
  }

  const steps: SupportStep[] = []
  for (const entry of r.steps) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) continue
    const value = typeof e.value === 'string' ? e.value.trim() : ''
    // A timestamp the client made up is still better than none for ordering,
    // but it must parse — otherwise fall back to now.
    const at =
      typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at))
        ? new Date(e.at).toISOString()
        : new Date().toISOString()
    steps.push({
      at,
      kind: e.kind as SupportStepKind,
      value: value.slice(0, SUPPORT_MAX_VALUE_LENGTH),
    })
  }

  if (steps.length === 0) return { ok: false, error: 'invalid_steps' }
  return { ok: true, value: { sessionId, steps } }
}

// --- DB accessors --------------------------------------------------------

type Row = Record<string, unknown>

function mapRow(r: Row): SupportSession {
  const raw = r.steps
  const steps = Array.isArray(raw)
    ? (raw as SupportStep[])
    : typeof raw === 'string'
      ? (JSON.parse(raw) as SupportStep[])
      : []
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    email: r.email == null ? null : String(r.email),
    steps,
    escalated: Boolean(r.escalated),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

const COLUMNS = `id, session_id, email, steps, escalated, created_at, updated_at`

/**
 * Upserts one session. The widget re-posts the whole step list as it grows, so
 * a session stays one row rather than accumulating one row per interaction.
 *
 * `email` is only ever written from the server-derived identity. It is also
 * COALESCEd on update so that a member who signs in mid-session keeps their
 * identity attached, and a later anonymous write can't blank it.
 */
export async function recordSupportSession(
  sql: Sql,
  input: SupportSessionInput,
  email: string | null,
): Promise<void> {
  const escalated = input.steps.some((s) => s.kind === 'escalate')
  await sql`
    insert into support_conversations (session_id, email, steps, escalated)
    values (
      ${input.sessionId},
      ${email},
      ${JSON.stringify(input.steps)}::jsonb,
      ${escalated}
    )
    on conflict (session_id) do update set
      email = coalesce(support_conversations.email, excluded.email),
      steps = excluded.steps,
      escalated = support_conversations.escalated or excluded.escalated,
      updated_at = now()
  `
}

/** Most recent sessions, for the back office. */
export const SUPPORT_SESSIONS_DEFAULT_LIMIT = 200

export async function listSupportSessions(
  sql: Sql,
  limit: number = SUPPORT_SESSIONS_DEFAULT_LIMIT,
): Promise<SupportSession[]> {
  // A non-finite limit means the caller could not read one, which is the
  // default's job — not the floor's. `Math.trunc(NaN) || 0` was 0, and the
  // clamp turned that into 1, so `?limit=abc` returned a single row and the
  // back office read as "almost nobody has used the widget".
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : SUPPORT_SESSIONS_DEFAULT_LIMIT
  const capped = Math.min(Math.max(requested, 1), 500)
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from support_conversations
    order by created_at desc
    limit ${capped}
  `) as Row[]
  return rows.map(mapRow)
}
