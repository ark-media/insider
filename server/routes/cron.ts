// Cron endpoints. Vercel cron hits these on a schedule; requests carry
// `Authorization: Bearer <CRON_SECRET>` matching the project's env secret.
//
//   /api/cron/reconcile-entitlements — nightly Stripe+Auth0+Circle sync.
//   /api/cron/notify-new-content     — email opted-in members about new
//                                      members-only episodes / community posts.

import crypto from 'node:crypto'
import {
  collectActiveStripeEmails,
  reconcileEntitlements,
} from '../entitlement.js'
import { getDb, type Sql } from '../lib/db.js'
import { sendEmail } from '../lib/email.js'
import { makeJsonRes } from '../lib/http.js'
import { getOptedOutEmails } from '../lib/notification-prefs.js'
import {
  runContentNotifications,
  type ContentItem,
  type ContentKind,
  type NotifyPorts,
} from '../lib/notify-content.js'
import {
  isPublishedEpisode,
  projectScEpisode,
  type ScEpisode,
} from '../show-notes.js'
import { isPublishedPost, type CirclePost } from '../circle-space-posts.js'
import type { Deps, Env, Route } from '../lib/route.js'

// Constant-time bearer check shared by both cron routes.
function cronAuthorized(authHeader: string | undefined, secret: string): boolean {
  const got = Buffer.from(authHeader ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

// --- Content adapters ------------------------------------------------------

// Members-only "Inside Call Me Back" episodes from Simplecast.
async function listInsideEpisodes(
  env: Env,
  appBaseUrl: string,
): Promise<ContentItem[]> {
  const podcastId = env.VITE_SIMPLECAST_PODCAST_ID_INSIDE_CALL_ME_BACK
  const token = env.SIMPLECAST_API_TOKEN
  if (!podcastId || !token) {
    console.warn('[notify] Inside Simplecast feed not configured — skipping episodes')
    return []
  }
  const url = `https://api.simplecast.com/podcasts/${encodeURIComponent(podcastId)}/episodes?limit=50`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Simplecast ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { collection?: ScEpisode[] }
  return (body.collection ?? [])
    .filter(isPublishedEpisode)
    .map((e) => projectScEpisode(e, 'inside-call-me-back'))
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id,
      title: p.title || 'New members-only episode',
      url: `${appBaseUrl}/plus/inside-call-me-back`,
      publishedAt: p.publishedAt,
    }))
}

// Recent community posts from the configured Circle space. CIRCLE_NOTIFY_SPACE_ID
// scopes which space's posts trigger emails; unset means "posts not wired yet".
async function listCommunityPosts(
  env: Env,
  appBaseUrl: string,
): Promise<ContentItem[]> {
  const token = env.CIRCLE_ADMIN_API_TOKEN
  const spaceId = env.CIRCLE_NOTIFY_SPACE_ID
  if (!token || !spaceId) {
    console.warn('[notify] Circle notify space not configured — skipping posts')
    return []
  }
  const url =
    `https://app.circle.so/api/admin/v2/posts` +
    `?space_id=${encodeURIComponent(spaceId)}&status=published&per_page=30&page=1`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Circle ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { records?: CirclePost[] }
  return (body.records ?? [])
    .filter(isPublishedPost)
    .filter((p) => p.id !== undefined && p.id !== null)
    .map((p) => ({
      id: String(p.id),
      title: p.name?.trim() || 'New community post',
      url: `${appBaseUrl}/community`,
      publishedAt: (p.published_at ?? p.created_at ?? '').slice(0, 10),
    }))
}

// --- Ledger (notified_content) ---------------------------------------------

async function getSeen(sql: Sql, kind: ContentKind): Promise<Set<string>> {
  const rows = (await sql`
    select content_id from notified_content where content_type = ${kind}
  `) as Array<{ content_id: string }>
  return new Set(rows.map((r) => r.content_id))
}

async function markSeen(
  sql: Sql,
  kind: ContentKind,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await sql`
      insert into notified_content (content_type, content_id)
      values (${kind}, ${id})
      on conflict (content_type, content_id) do nothing
    `
  }
}

// --- Email -----------------------------------------------------------------

function notificationEmail(kind: ContentKind, item: ContentItem) {
  const isEpisode = kind === 'episode'
  const subject = isEpisode
    ? `New Inside Call Me Back episode: ${item.title}`
    : `New community post: ${item.title}`
  const cta = isEpisode ? 'Listen now' : 'Read it'
  const intro = isEpisode
    ? 'A new members-only episode is live.'
    : 'A new post is up in the community.'
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
      <p style="margin:0 0 12px">${intro}</p>
      <p style="margin:0 0 20px;font-size:18px;font-weight:700">${item.title}</p>
      <p style="margin:0 0 24px">
        <a href="${item.url}" style="background:#0e7490;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${cta}</a>
      </p>
      <p style="margin:0;font-size:12px;color:#64748b">You're getting this because you opted in to ${isEpisode ? 'new-episode' : 'new-post'} alerts. Manage these in your account under Newsletter preferences.</p>
    </div>`
  return { subject, html }
}

// --- Routes ----------------------------------------------------------------

export function cronRoutes({ env, stripe, appBaseUrl }: Deps): Route[] {
  return [
    {
      path: '/api/cron/reconcile-entitlements',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST' && req.method !== 'GET') {
          return json(405, { error: 'Method Not Allowed' })
        }
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'CRON_SECRET missing' })
        if (!cronAuthorized(req.headers.authorization, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })

        const summary = await reconcileEntitlements(env, stripe)
        json(200, {
          scanned: summary.scanned,
          upgraded: summary.upgraded,
          downgraded: summary.downgraded,
          errors: summary.errors,
        })
      },
    },
    {
      path: '/api/cron/notify-new-content',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST' && req.method !== 'GET') {
          return json(405, { error: 'Method Not Allowed' })
        }
        const cronSecret = env.CRON_SECRET
        if (!cronSecret) return json(500, { error: 'CRON_SECRET missing' })
        if (!cronAuthorized(req.headers.authorization, cronSecret)) {
          return json(401, { error: 'unauthorized' })
        }
        if (!stripe) return json(500, { error: 'STRIPE_SECRET_KEY missing' })
        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }

        const sql = getDb(env)

        // Member audience resolved lazily and cached for the run — most runs
        // find nothing new and never touch Stripe.
        let memberCache: string[] | null = null
        const listMemberEmails = async () => {
          if (memberCache) return memberCache
          const set = await collectActiveStripeEmails(stripe, 10)
          memberCache = [...set].map((e) => e.toLowerCase())
          return memberCache
        }

        const ports: NotifyPorts = {
          listItems: (kind) =>
            kind === 'episode'
              ? listInsideEpisodes(env, appBaseUrl)
              : listCommunityPosts(env, appBaseUrl),
          getSeen: (kind) => getSeen(sql, kind),
          markSeen: (kind, ids) => markSeen(sql, kind, ids),
          listMemberEmails,
          getOptedOut: (kind) =>
            getOptedOutEmails(sql, kind === 'episode' ? 'episodes' : 'posts'),
          send: (to, kind, item) => {
            const { subject, html } = notificationEmail(kind, item)
            return sendEmail(env, { to, subject, html })
          },
        }

        try {
          const results = await runContentNotifications(ports)
          json(200, { results })
        } catch (err) {
          console.error('[notify] run failed:', err)
          json(502, { error: 'notify_failed' })
        }
      },
    },
  ]
}
