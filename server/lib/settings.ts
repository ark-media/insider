// App settings: a tiny singleton key/value store for global runtime flags
// managed from the admin back office. Today it holds exactly one key,
// `launch_mode`, which toggles the site between the focused soft-launch
// ("Inside Call Me Back") experience and the full hard-launch site.
//
// Thin DB accessors over `Sql`, mirroring server/lib/announcements.ts. The
// default is "soft" so a missing row — or any unexpected stored value — is the
// safe, nothing-leaks state pre-launch.

import type { Sql } from './db.js'

export type LaunchMode = 'soft' | 'hard'

export const DEFAULT_LAUNCH_MODE: LaunchMode = 'soft'
const LAUNCH_MODE_KEY = 'launch_mode'

export function isLaunchMode(value: unknown): value is LaunchMode {
  return value === 'soft' || value === 'hard'
}

type Row = Record<string, unknown>

export async function getLaunchMode(sql: Sql): Promise<LaunchMode> {
  const rows = (await sql`
    select value from app_settings where key = ${LAUNCH_MODE_KEY} limit 1
  `) as Row[]
  const value = rows[0]?.value
  return isLaunchMode(value) ? value : DEFAULT_LAUNCH_MODE
}

export async function setLaunchMode(sql: Sql, mode: LaunchMode): Promise<LaunchMode> {
  await sql`
    insert into app_settings (key, value)
    values (${LAUNCH_MODE_KEY}, ${mode})
    on conflict (key) do update set value = ${mode}, updated_at = now()
  `
  return mode
}
