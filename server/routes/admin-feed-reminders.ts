// Admin config for the feed-setup reminder cron.
//
//   GET /api/admin/feed-reminders — the live config (admin-set row, else the
//     env/code fallback) so the form can prefill.
//   PUT /api/admin/feed-reminders — replace the config. Validated, then stored
//     in app_settings; the cron reads it on its next run.
//
// Admin-gated (Auth0 "admin" role) + same-origin on the mutation, like the
// other back-office routes. Each save is recorded in the admin audit log — these
// two configs decide who gets emailed and when, so "who turned that on?" needs
// an answer.

import { readJson } from '../lib/http.js'
import { requireAdminRequest } from '../lib/guards.js'
import { logAdminAction } from '../lib/admin-audit.js'
import { getDb } from '../lib/db.js'
import {
  getMigrationConfig,
  getReminderConfig,
  setMigrationConfig,
  setReminderConfig,
} from '../lib/app-settings.js'
import { validateReminderConfig } from '../../shared/feed-reminder.js'
import { validateMigrationConfig } from '../../shared/feed-migration.js'
import { defineRoute } from '../lib/route.js'
import type { Deps, Route } from '../lib/route.js'

export function adminFeedReminderRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: '/api/admin/feed-reminders',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }
        const sql = getDb(env)

        if (req.method === 'GET') {
          return json(200, { config: await getReminderConfig(sql, env) })
        }
        if (req.method === 'PUT') {
          const v = validateReminderConfig(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          await setReminderConfig(sql, v.value)
          await logAdminAction(env, admin, req, {
            action: 'feed_reminders.update',
            summary: `enabled=${v.value.enabled}`,
          })
          return json(200, { config: v.value })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    }),
    defineRoute({
      // The feed-migration check-in campaign. A sibling of the route above
      // rather than a field on it: the two configure different campaigns on
      // different clocks, and folding them into one payload would mean every
      // save of one rewrites the other.
      path: '/api/admin/feed-migration',
      handler: async (req, res, json) => {
        const admin = await requireAdminRequest(req, res, env, appBaseUrl)
        if (!admin) return
        if (!env.DATABASE_URL) {
          return json(500, { error: 'database_not_configured' })
        }
        const sql = getDb(env)

        if (req.method === 'GET') {
          return json(200, { config: await getMigrationConfig(sql) })
        }
        if (req.method === 'PUT') {
          const v = validateMigrationConfig(await readJson(req))
          if (!v.ok) return json(400, { error: v.error })
          await setMigrationConfig(sql, v.value)
          await logAdminAction(env, admin, req, {
            action: 'feed_migration.update',
            summary: `enabled=${v.value.enabled}`,
          })
          return json(200, { config: v.value })
        }
        return json(405, { error: 'Method Not Allowed' })
      },
    }),
  ]
}
