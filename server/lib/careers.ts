// Careers: admin-managed job postings, shown on /careers (list) and
// /careers/<slug> (detail). Managed from the admin back office; the public
// endpoint reads only enabled rows.
//
// Split into pure helpers (slugify/sanitize/validate — unit-tested with plain
// objects) and thin DB accessors over `Sql`. Unlike the announcement banner
// (inline formatting only), a job description is a full document, so the
// sanitizer here allows block-level tags (headings, lists, paragraphs).

import sanitizeHtml from 'sanitize-html'
import { sanitizeRichText } from './richText.js'
import type { Sql } from './db.js'
import type { Career } from '../../shared/career.js'

export type { Career }

export type CareerInput = {
  slug: string
  title: string
  team: string | null
  location: string | null
  employmentType: string | null
  summary: string
  description: string
  applyUrl: string | null
  enabled: boolean
  displayOrder: number
}

// The detail page renders a real document, using the shared back-office
// allowlist (see server/lib/richText.ts) — headings, paragraphs, lists, inline
// formatting, and links. Scripts, styles, images, and event handlers stripped.
export function sanitizeCareerDescription(html: string): string {
  return sanitizeRichText(html)
}

// A short, plain-text blurb for the list card — strip all markup.
export function sanitizeSummary(text: string): string {
  return sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }).trim()
}

// URL-safe slug for the /careers/<slug> route. Lowercase, alphanumerics joined
// by single hyphens, no leading/trailing hyphen.
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Apply URL is the external application link (TestGorilla, a careers site, or a
// mailto). Returns the trimmed value, null when empty, or an Error message
// string when it's neither — so a typo'd link is rejected rather than rendered
// as a dead button.
export function normalizeApplyUrl(raw: unknown): string | null | { error: string } {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return { error: 'Apply URL must be a string.' }
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
      return { error: 'Apply URL must use http(s) or mailto.' }
    }
    return value
  } catch {
    return { error: 'Apply URL is not a valid URL.' }
  }
}

function optionalString(raw: unknown): string | null {
  if (raw == null) return null
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v ? v : null
}

export type ValidationResult =
  | { ok: true; value: CareerInput }
  | { ok: false; error: string }

// Validates + normalizes raw admin JSON into a storable CareerInput. Pure (no
// DB), so it's unit-tested directly. Description is sanitized here; after
// stripping markup it must still contain visible text. Slug falls back to a
// slugified title when omitted, and is always re-normalized so a hand-typed
// slug can't be unsafe.
export function validateCareerInput(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.title !== 'string' || !r.title.trim()) {
    return { ok: false, error: 'Title is required.' }
  }
  const title = r.title.trim()

  // Slug: use the provided one if any, else derive from the title. Either way,
  // run it through slugify so the stored value is always route-safe.
  const slugSource =
    typeof r.slug === 'string' && r.slug.trim() ? r.slug : title
  const slug = slugify(slugSource)
  if (!slug) {
    return { ok: false, error: 'Could not derive a URL slug — add letters or numbers to the title or slug.' }
  }

  if (typeof r.summary !== 'string' || !sanitizeSummary(r.summary)) {
    return { ok: false, error: 'Summary is required.' }
  }
  const summary = sanitizeSummary(r.summary)

  if (typeof r.description !== 'string' || !r.description.trim()) {
    return { ok: false, error: 'Description is required.' }
  }
  const description = sanitizeCareerDescription(r.description).trim()
  const textOnly = sanitizeHtml(description, { allowedTags: [], allowedAttributes: {} }).trim()
  if (!textOnly) {
    return { ok: false, error: 'Description has no visible text after sanitizing.' }
  }

  const applyUrl = normalizeApplyUrl(r.applyUrl)
  if (applyUrl !== null && typeof applyUrl === 'object') {
    return { ok: false, error: applyUrl.error }
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

  return {
    ok: true,
    value: {
      slug,
      title,
      team: optionalString(r.team),
      location: optionalString(r.location),
      employmentType: optionalString(r.employmentType),
      summary,
      description,
      applyUrl,
      enabled,
      displayOrder,
    },
  }
}

// --- DB accessors --------------------------------------------------------

type Row = Record<string, unknown>

function mapRow(r: Row): Career {
  return {
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.title),
    team: r.team == null ? null : String(r.team),
    location: r.location == null ? null : String(r.location),
    employmentType: r.employment_type == null ? null : String(r.employment_type),
    summary: String(r.summary),
    // Re-sanitized on read as well as write — see the note in lib/faqs.ts:
    // stored HTML shouldn't be trusted just because the normal write path
    // validates it.
    description: sanitizeRichText(String(r.description)),
    applyUrl: r.apply_url == null ? null : String(r.apply_url),
    enabled: Boolean(r.enabled),
    displayOrder: Number(r.display_order),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

const COLUMNS = `id, slug, title, team, location, employment_type, summary,
  description, apply_url, enabled, display_order, created_at, updated_at`

// All postings, for the admin list (enabled or not).
export async function listCareers(sql: Sql): Promise<Career[]> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from careers
    order by display_order asc, created_at asc
    limit 500
  `) as Row[]
  return rows.map(mapRow)
}

// Enabled postings only, for the public /careers list.
export async function listEnabledCareers(sql: Sql): Promise<Career[]> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from careers
    where enabled = true
    order by display_order asc, created_at asc
    limit 500
  `) as Row[]
  return rows.map(mapRow)
}

// A single enabled posting by slug, for the public detail page. Disabled
// postings 404 on the public site even if someone has the link.
export async function getEnabledCareerBySlug(sql: Sql, slug: string): Promise<Career | null> {
  const rows = (await sql`
    select ${sql.unsafe(COLUMNS)} from careers
    where enabled = true and slug = ${slug}
    limit 1
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createCareer(sql: Sql, input: CareerInput): Promise<Career> {
  const rows = (await sql`
    insert into careers
      (slug, title, team, location, employment_type, summary, description, apply_url, enabled, display_order)
    values
      (${input.slug}, ${input.title}, ${input.team}, ${input.location}, ${input.employmentType},
       ${input.summary}, ${input.description}, ${input.applyUrl}, ${input.enabled}, ${input.displayOrder})
    returning ${sql.unsafe(COLUMNS)}
  `) as Row[]
  return mapRow(rows[0])
}

export async function updateCareer(
  sql: Sql,
  id: string,
  input: CareerInput,
): Promise<Career | null> {
  const rows = (await sql`
    update careers set
      slug = ${input.slug},
      title = ${input.title},
      team = ${input.team},
      location = ${input.location},
      employment_type = ${input.employmentType},
      summary = ${input.summary},
      description = ${input.description},
      apply_url = ${input.applyUrl},
      enabled = ${input.enabled},
      display_order = ${input.displayOrder},
      updated_at = now()
    where id = ${id}
    returning ${sql.unsafe(COLUMNS)}
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteCareer(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`delete from careers where id = ${id} returning id`) as Row[]
  return rows.length > 0
}

// Postgres unique-violation (duplicate slug). The route turns this into a 409
// with a friendly message instead of a generic 500.
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  )
}
