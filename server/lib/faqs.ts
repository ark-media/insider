// FAQs: admin-managed frequently-asked questions, shown on the /plus FAQ
// section. Managed from the admin back office; the public endpoint reads only
// enabled rows. Mirrors the careers module (server/lib/careers.ts) minus the
// slug/detail-page concerns — an FAQ has no standalone URL.
//
// Split into pure helpers (sanitize/validate — unit-tested with plain objects)
// and thin DB accessors over `Sql`. The answer is a short rich-text block, so
// the sanitizer allows paragraphs, lists, inline formatting, and links — but
// not headings (an answer doesn't need document structure).

import sanitizeHtml from 'sanitize-html'
import { sanitizeRichText } from './richText.js'
import type { Sql } from './db.js'
import type { Faq } from '../../shared/faq.js'

export type { Faq }

export type FaqInput = {
  key: string | null
  question: string
  answer: string
  category: string
  enabled: boolean
  displayOrder: number
}

// The answer renders rich text via the shared back-office allowlist (see
// server/lib/richText.ts) — paragraphs, lists, headings, inline formatting,
// and links. Scripts, styles, images, and event handlers are stripped.
export function sanitizeFaqAnswer(html: string): string {
  return sanitizeRichText(html)
}

// The question is a plain-text label — strip all markup.
export function sanitizeQuestion(text: string): string {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).trim()
}

export type ValidationResult =
  | { ok: true; value: FaqInput }
  | { ok: false; error: string }

// Validates + normalizes raw admin JSON into a storable FaqInput. Pure (no DB),
// so it's unit-tested directly. The answer is sanitized here; after stripping
// markup it must still contain visible text.
export function validateFaqInput(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.question !== 'string' || !sanitizeQuestion(r.question)) {
    return { ok: false, error: 'Question is required.' }
  }
  const question = sanitizeQuestion(r.question)

  if (typeof r.answer !== 'string' || !r.answer.trim()) {
    return { ok: false, error: 'Answer is required.' }
  }
  const answer = sanitizeFaqAnswer(r.answer).trim()
  const textOnly = sanitizeHtml(answer, { allowedTags: [], allowedAttributes: {} }).trim()
  if (!textOnly) {
    return { ok: false, error: 'Answer has no visible text after sanitizing.' }
  }

  // Category is an optional plain-text section heading; strip any markup.
  const category = typeof r.category === 'string' ? sanitizeQuestion(r.category) : ''

  // The key is a code-facing slug, not prose: lowercase letters, digits and
  // hyphens. Blank means "nothing references this row", stored as null so the
  // unique index ignores it (Postgres allows many nulls). Validated rather
  // than slugified, because silently rewriting an editor's key would break the
  // binding it was typed to fix.
  let key: string | null = null
  if (typeof r.key === 'string' && r.key.trim()) {
    key = r.key.trim().toLowerCase()
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) {
      return {
        ok: false,
        error: 'Key must be lowercase letters, numbers and single hyphens.',
      }
    }
  }

  const enabled = r.enabled == null ? true : r.enabled === true

  let displayOrder = 0
  if (r.displayOrder != null) {
    const n = Number(r.displayOrder)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: 'Display order must be a whole number.' }
    }
    displayOrder = n
  }

  return { ok: true, value: { key, question, answer, category, enabled, displayOrder } }
}

// --- DB accessors --------------------------------------------------------

type Row = Record<string, unknown>

// Re-sanitize the stored rich text on the way OUT, not just on the way in.
// Every write path validates, but stored HTML is otherwise trusted forever: a
// seed script, a migration, a manual SQL fix, or a future endpoint that skips
// validation would render unsanitized, and tightening the allowlist later
// wouldn't retroactively clean existing rows. sanitizeRichText is cheap and
// idempotent, so making the projection the enforcement point costs nothing.
function mapRow(r: Row): Faq {
  return {
    id: String(r.id),
    key: r.key == null ? null : String(r.key),
    question: String(r.question),
    answer: sanitizeRichText(String(r.answer)),
    category: String(r.category ?? ''),
    enabled: Boolean(r.enabled),
    displayOrder: Number(r.display_order),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

const COLUMNS = `id, key, question, answer, category, enabled, display_order, created_at, updated_at`

// All FAQs, for the admin list (enabled or not).
export async function listFaqs(sql: Sql): Promise<Faq[]> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from faqs
    order by display_order asc, created_at asc
    limit 500
  `) as Row[]
  return rows.map(mapRow)
}

// Enabled FAQs only, for the public /plus section.
export async function listEnabledFaqs(sql: Sql): Promise<Faq[]> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from faqs
    where enabled = true
    order by display_order asc, created_at asc
    limit 500
  `) as Row[]
  return rows.map(mapRow)
}

/**
 * Thrown when a write would give two rows the same `key`.
 *
 * `faqs_key_idx` is the only constraint an editor can trip from the form, and
 * uncaught it arrives as a bare Postgres 23505 that the route's catch-all turns
 * into `internal_error` — a generic failure that says nothing about the key,
 * next to the key that caused it. Uniqueness can't be validated up front
 * without a race, so it is caught where the database reports it.
 */
export class DuplicateFaqKeyError extends Error {
  key: string
  constructor(key: string) {
    super(`FAQ key "${key}" is already in use`)
    this.name = 'DuplicateFaqKeyError'
    this.key = key
  }
}

function isDuplicateKey(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code
  const constraint = (err as { constraint_name?: unknown })?.constraint_name
  return code === '23505' && (constraint == null || constraint === 'faqs_key_idx')
}

export async function createFaq(sql: Sql, input: FaqInput): Promise<Faq> {
  let rows: Row[]
  try {
    rows = (await sql`
      insert into faqs (key, question, answer, category, enabled, display_order)
      values (${input.key}, ${input.question}, ${input.answer}, ${input.category}, ${input.enabled}, ${input.displayOrder})
      returning ${sql.unsafe(COLUMNS)}
    `) as Row[]
  } catch (err) {
    if (input.key && isDuplicateKey(err)) throw new DuplicateFaqKeyError(input.key)
    throw err
  }
  return mapRow(rows[0])
}

export async function updateFaq(
  sql: Sql,
  id: string,
  input: FaqInput,
): Promise<Faq | null> {
  let rows: Row[]
  try {
    rows = (await sql`
      update faqs set
        key = ${input.key},
        question = ${input.question},
        answer = ${input.answer},
        category = ${input.category},
        enabled = ${input.enabled},
        display_order = ${input.displayOrder},
        updated_at = now()
      where id = ${id}
      returning ${sql.unsafe(COLUMNS)}
    `) as Row[]
  } catch (err) {
    if (input.key && isDuplicateKey(err)) throw new DuplicateFaqKeyError(input.key)
    throw err
  }
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteFaq(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`delete from faqs where id = ${id} returning id`) as Row[]
  return rows.length > 0
}
