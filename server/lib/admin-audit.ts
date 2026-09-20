// Audit trail for the back office: who did what, and when.
//
// `requireAdminRequest` (guards.ts) hands each admin route the profile of the
// admin who passed the gate. Every successful mutation — and every bulk read of
// member data — passes it here, and one row lands in `admin_audit_log`
// (migrations/0005). The admins are few and trusted; the point is not to catch
// them, it is to be able to answer "who deleted that promo?" or "was the
// cancellation list exported the week the address leaked?" at all.
//
// Two trails, on purpose. The console line is written FIRST and unconditionally,
// so the function logs still hold the event when the insert can't happen: no
// DATABASE_URL (local dev, most tests), a Neon blip, or — the case that has
// already taken this site down once — code deployed ahead of its migration, so
// the table isn't there yet. The row is the durable, queryable copy.
//
// Never throws and never rejects. A failed audit write must not turn a mutation
// that already succeeded into a 500: the admin would retry and do it twice.
// Failures are one greppable `[admin-audit]` console.error line instead.
//
// `summary` is for the WHAT, in a few words: a coupon code and its percent, a
// FAQ key, the filter an export ran with and how many rows it returned. Never
// the rows themselves, never a secret, and no member PII beyond what names the
// target — this table is readable by anyone with database access and is not
// where a member's details should accumulate.

import type { IncomingMessage } from 'node:http'
import { getDb } from './db.js'
import type { Auth0Profile } from './session.js'

type Env = Record<string, string>

export type AdminAuditEntry = {
  /** Dotted `<resource>.<verb>`, e.g. `promo.create`. Stable — it gets queried. */
  action: string
  /** The row/object acted on, when there is one (a uuid, a Stripe coupon id). */
  targetId?: string | null
  /** Short human-readable detail. See the header for what stays out of it. */
  summary?: string | null
}

// Columns are `text`, so nothing enforces a length; these keep one careless
// caller (or one enormous FAQ question) from bloating the table and the logs.
const SUMMARY_MAX = 300
const FIELD_MAX = 200

// The insert rides the request, before the response is written — on Vercel a
// promise left running after `res.end` may never finish. So it gets a deadline:
// an audit row is not worth holding an admin's save open for.
const INSERT_TIMEOUT_MS = 3000

// Postgres `undefined_table`. Expected for the window between a deploy and its
// migration, so it gets its own line saying what to do about it.
const UNDEFINED_TABLE = '42P01'

// Control characters out (a summary built from admin-typed text must not be able
// to forge a second log line), whitespace collapsed, length capped.
function clean(value: string | null | undefined, max: number): string | null {
  if (value == null) return null
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// Pathname only. The query string is where a member-directory search carries
// the email being looked up, and it has no business in the trail.
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://x').pathname
  } catch {
    return '/'
  }
}

export async function logAdminAction(
  env: Env,
  admin: Pick<Auth0Profile, 'email' | 'sub'>,
  req: IncomingMessage,
  entry: AdminAuditEntry,
): Promise<void> {
  try {
    const row = {
      admin_sub: clean(admin.sub, FIELD_MAX),
      admin_email: clean(admin.email, FIELD_MAX) ?? 'unknown',
      method: clean(req.method, 16) ?? 'GET',
      path: clean(pathOf(req), FIELD_MAX) ?? '/',
      action: clean(entry.action, FIELD_MAX) ?? 'unknown',
      target_id: clean(entry.targetId, FIELD_MAX),
      summary: clean(entry.summary, SUMMARY_MAX),
    }

    // The trail that survives everything below.
    console.log(`[admin-audit] ${JSON.stringify({ at: new Date().toISOString(), ...row })}`)

    if (!env.DATABASE_URL) return

    const sql = getDb(env)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${INSERT_TIMEOUT_MS}ms`)),
        INSERT_TIMEOUT_MS,
      )
    })
    try {
      await Promise.race([
        sql`
          insert into admin_audit_log
            (admin_sub, admin_email, method, path, action, target_id, summary)
          values
            (${row.admin_sub}, ${row.admin_email}, ${row.method}, ${row.path},
             ${row.action}, ${row.target_id}, ${row.summary})
        `,
        deadline,
      ])
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? (err as { code?: unknown }).code
        : undefined
    if (code === UNDEFINED_TABLE) {
      console.error(
        '[admin-audit] insert skipped: admin_audit_log does not exist yet (apply migrations/0005_admin_audit_log.sql)',
      )
      return
    }
    console.error('[admin-audit] insert failed:', err instanceof Error ? err.message : err)
  }
}
