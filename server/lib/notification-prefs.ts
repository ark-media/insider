// Content-notification preferences store. Backs the per-member "email me about
// new episodes / new posts" toggles on /account/newsletters. We own these
// because Supporting Cast's hosted toggles have no API surface.
//
// Defaults live here, not in the table: a member with no row is opted in to
// both. The cron sender reads the same shape to decide who to email.

import type { Sql } from './db.js'

export type ContentNotificationPrefs = {
  episodes: boolean
  posts: boolean
}

const DEFAULTS: ContentNotificationPrefs = { episodes: true, posts: true }

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

type Row = { notify_episodes: boolean; notify_posts: boolean }

export async function getContentNotificationPrefs(
  sql: Sql,
  email: string,
): Promise<ContentNotificationPrefs> {
  const rows = (await sql`
    select notify_episodes, notify_posts
    from content_notification_pref
    where email = ${normalizeEmail(email)}
  `) as Row[]
  const row = rows[0]
  if (!row) return { ...DEFAULTS }
  return { episodes: row.notify_episodes, posts: row.notify_posts }
}

// Emails that have explicitly opted OUT of a given notification kind. Members
// with no row default to opted-in, so they're absent here — the cron starts
// from the full member list and subtracts this set.
export async function getOptedOutEmails(
  sql: Sql,
  kind: keyof ContentNotificationPrefs,
): Promise<Set<string>> {
  const rows = (await (kind === 'episodes'
    ? sql`select email from content_notification_pref where notify_episodes = false`
    : sql`select email from content_notification_pref where notify_posts = false`)) as Array<{
    email: string
  }>
  return new Set(rows.map((r) => r.email))
}

export async function setContentNotificationPrefs(
  sql: Sql,
  email: string,
  patch: Partial<ContentNotificationPrefs>,
): Promise<ContentNotificationPrefs> {
  const current = await getContentNotificationPrefs(sql, email)
  const next: ContentNotificationPrefs = {
    episodes: patch.episodes ?? current.episodes,
    posts: patch.posts ?? current.posts,
  }
  await sql`
    insert into content_notification_pref (email, notify_episodes, notify_posts, updated_at)
    values (${normalizeEmail(email)}, ${next.episodes}, ${next.posts}, now())
    on conflict (email) do update
      set notify_episodes = excluded.notify_episodes,
          notify_posts    = excluded.notify_posts,
          updated_at      = now()
  `
  return next
}
