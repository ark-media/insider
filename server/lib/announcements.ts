// Announcements: the dismissible promo banner shown at the top of the site,
// managed from the admin back office. Stripe owns promo codes; this module
// owns the *banner* that markets them.
//
// Split into pure helpers (sanitize/validate — unit-tested with plain objects)
// and thin DB accessors over `Sql`. Active-window selection is done in SQL so
// the public endpoint never loads the full table.

import sanitizeHtml from 'sanitize-html'
import { sanitizeRichText } from './richText.js'
import type { Sql } from './db.js'
import type { Announcement } from '../../shared/announcement.js'

// The API shape lives in shared/ (client + server contract); `mapRow` bridges
// the snake_case DB columns to it and normalizes timestamps to ISO-8601 Z.
export type { Announcement }

export type AnnouncementInput = {
  body: string
  actionUrl: string | null
  barColor: string
  textColor: string
  dismissible: boolean
  enabled: boolean
  startsAt: string
  endsAt: string
}

export const DEFAULT_BAR_COLOR = '#4a9fe8'
export const DEFAULT_TEXT_COLOR = '#ffffff'

// The banner uses the same shared back-office allowlist as every other admin
// editor (see server/lib/richText.ts), so it offers — and keeps — the full
// formatting set. Admins typically write one short line; block content (lists,
// headings, multiple paragraphs) is permitted and renders in the bar.
export function sanitizeAnnouncementBody(html: string): string {
  return sanitizeRichText(html)
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

// Action URL may be an absolute http(s) link or a site-relative path ("/plus").
// Returns the trimmed value, null when empty, or an Error message string when
// it's neither — so a typo'd URL is rejected rather than rendered as a dead
// link.
export function normalizeActionUrl(raw: unknown): string | null | { error: string } {
  if (raw == null || raw === '') return null
  if (typeof raw !== 'string') return { error: 'Action URL must be a string.' }
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('/')) {
    // Reject protocol-relative URLs ("//host") — they read as relative but the
    // browser navigates off-site. Only a single leading slash is a site path.
    if (value.startsWith('//')) {
      return { error: 'Action URL must be absolute (http/https) or a site path like /plus.' }
    }
    return value
  }
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: 'Action URL must use http(s) or be a relative path.' }
    }
    return value
  } catch {
    return { error: 'Action URL is not a valid URL.' }
  }
}

export type ValidationResult =
  | { ok: true; value: AnnouncementInput }
  | { ok: false; error: string }

// Validates + normalizes raw admin JSON into a storable AnnouncementInput.
// Pure (no DB), so it's unit-tested directly. Body is sanitized here, and the
// sanitized result must still contain visible text — an empty or
// markup-only body is rejected.
export function validateAnnouncementInput(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>

  if (typeof r.body !== 'string' || !r.body.trim()) {
    return { ok: false, error: 'Body is required.' }
  }
  const body = sanitizeAnnouncementBody(r.body).trim()
  // After sanitizing + stripping all tags, there must be real text left.
  const textOnly = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} }).trim()
  if (!textOnly) {
    return { ok: false, error: 'Body has no visible text after sanitizing.' }
  }

  const actionUrl = normalizeActionUrl(r.actionUrl)
  if (actionUrl !== null && typeof actionUrl === 'object') {
    return { ok: false, error: actionUrl.error }
  }

  const barColor = r.barColor == null || r.barColor === '' ? DEFAULT_BAR_COLOR : r.barColor
  if (typeof barColor !== 'string' || !isHexColor(barColor)) {
    return { ok: false, error: 'Bar color must be a hex color like #4a9fe8.' }
  }
  const textColor = r.textColor == null || r.textColor === '' ? DEFAULT_TEXT_COLOR : r.textColor
  if (typeof textColor !== 'string' || !isHexColor(textColor)) {
    return { ok: false, error: 'Text color must be a hex color like #ffffff.' }
  }

  const dismissible = r.dismissible == null ? true : r.dismissible === true
  const enabled = r.enabled == null ? true : r.enabled === true

  const startsAt = parseTimestamp(r.startsAt)
  if (!startsAt) return { ok: false, error: 'Start date is required and must be valid.' }
  const endsAt = parseTimestamp(r.endsAt)
  if (!endsAt) return { ok: false, error: 'End date is required and must be valid.' }
  if (new Date(endsAt) <= new Date(startsAt)) {
    return { ok: false, error: 'End date must be after the start date.' }
  }

  return {
    ok: true,
    value: { body, actionUrl, barColor, textColor, dismissible, enabled, startsAt, endsAt },
  }
}

function parseTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

// --- DB accessors --------------------------------------------------------

type Row = Record<string, unknown>

function mapRow(r: Row): Announcement {
  return {
    id: String(r.id),
    body: String(r.body),
    actionUrl: r.action_url == null ? null : String(r.action_url),
    barColor: String(r.bar_color),
    textColor: String(r.text_color),
    dismissible: Boolean(r.dismissible),
    enabled: Boolean(r.enabled),
    startsAt: new Date(r.starts_at as string).toISOString(),
    endsAt: new Date(r.ends_at as string).toISOString(),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  }
}

export async function listAnnouncements(sql: Sql): Promise<Announcement[]> {
  const rows = (await sql`
    select id, body, action_url, bar_color, text_color, dismissible, enabled,
           starts_at, ends_at, created_at, updated_at
    from announcements
    order by starts_at desc, created_at desc
  `) as Row[]
  return rows.map(mapRow)
}

// The single banner to show right now: enabled and within its window. If
// windows overlap, the most recently started one wins.
export async function getActiveAnnouncement(
  sql: Sql,
  now: Date = new Date(),
): Promise<Announcement | null> {
  const nowIso = now.toISOString()
  const rows = (await sql`
    select id, body, action_url, bar_color, text_color, dismissible, enabled,
           starts_at, ends_at, created_at, updated_at
    from announcements
    where enabled = true and starts_at <= ${nowIso} and ends_at >= ${nowIso}
    order by starts_at desc
    limit 1
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createAnnouncement(
  sql: Sql,
  input: AnnouncementInput,
): Promise<Announcement> {
  const rows = (await sql`
    insert into announcements
      (body, action_url, bar_color, text_color, dismissible, enabled, starts_at, ends_at)
    values
      (${input.body}, ${input.actionUrl}, ${input.barColor}, ${input.textColor},
       ${input.dismissible}, ${input.enabled}, ${input.startsAt}, ${input.endsAt})
    returning id, body, action_url, bar_color, text_color, dismissible, enabled,
              starts_at, ends_at, created_at, updated_at
  `) as Row[]
  return mapRow(rows[0])
}

export async function updateAnnouncement(
  sql: Sql,
  id: string,
  input: AnnouncementInput,
): Promise<Announcement | null> {
  const rows = (await sql`
    update announcements set
      body = ${input.body},
      action_url = ${input.actionUrl},
      bar_color = ${input.barColor},
      text_color = ${input.textColor},
      dismissible = ${input.dismissible},
      enabled = ${input.enabled},
      starts_at = ${input.startsAt},
      ends_at = ${input.endsAt},
      updated_at = now()
    where id = ${id}
    returning id, body, action_url, bar_color, text_color, dismissible, enabled,
              starts_at, ends_at, created_at, updated_at
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteAnnouncement(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`delete from announcements where id = ${id} returning id`) as Row[]
  return rows.length > 0
}
