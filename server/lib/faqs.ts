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

  const enabled = r.enabled == null ? true : r.enabled === true

  let displayOrder = 0
  if (r.displayOrder != null) {
    const n = Number(r.displayOrder)
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: 'Display order must be a whole number.' }
    }
    displayOrder = n
  }

  return { ok: true, value: { question, answer, category, enabled, displayOrder } }
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
    question: String(r.question),
    answer: sanitizeRichText(String(r.answer)),
    category: String(r.category ?? ''),
    enabled: Boolean(r.enabled),
    displayOrder: Number(r.display_order),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

const COLUMNS = `id, question, answer, category, enabled, display_order, created_at, updated_at`

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

export async function createFaq(sql: Sql, input: FaqInput): Promise<Faq> {
  const rows = (await sql`
    insert into faqs (question, answer, category, enabled, display_order)
    values (${input.question}, ${input.answer}, ${input.category}, ${input.enabled}, ${input.displayOrder})
    returning ${sql.unsafe(COLUMNS)}
  `) as Row[]
  return mapRow(rows[0])
}

export async function updateFaq(
  sql: Sql,
  id: string,
  input: FaqInput,
): Promise<Faq | null> {
  const rows = (await sql`
    update faqs set
      question = ${input.question},
      answer = ${input.answer},
      category = ${input.category},
      enabled = ${input.enabled},
      display_order = ${input.displayOrder},
      updated_at = now()
    where id = ${id}
    returning ${sql.unsafe(COLUMNS)}
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteFaq(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`delete from faqs where id = ${id} returning id`) as Row[]
  return rows.length > 0
}
