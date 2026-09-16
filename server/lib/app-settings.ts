// Generic key/value settings, backed by the app_settings table. Values are
// stored as text (JSON for structured settings). Deliberately thin — the back
// office is the only writer.

import type { Sql } from './db.js'
import {
  validateReminderConfig,
  type ReminderConfig,
} from '../../shared/feed-reminder.js'
import {
  DEFAULT_MIGRATION_CONFIG,
  validateMigrationConfig,
  type MigrationConfig,
} from '../../shared/feed-migration.js'
import { loadReminderConfigFromEnv } from './feed-reminders.js'

type Env = Record<string, string>

const REMINDER_CONFIG_KEY = 'feed_reminder_config'
const MIGRATION_CONFIG_KEY = 'feed_migration_config'

async function getSetting(sql: Sql, key: string): Promise<string | null> {
  const rows = (await sql`
    select value from app_settings where key = ${key} limit 1`) as Array<{
    value: string
  }>
  return rows[0]?.value ?? null
}

async function setSetting(sql: Sql, key: string, value: string): Promise<void> {
  await sql`
    insert into app_settings (key, value, updated_at)
    values (${key}, ${value}, now())
    on conflict (key) do update set value = ${value}, updated_at = now()`
}

// Resolve the live reminder config. Precedence: the admin-set DB row, then env
// overrides, then code defaults. A malformed/legacy DB value falls back rather
// than throwing, so a bad row can't break the cron.
export async function getReminderConfig(
  sql: Sql,
  env: Env,
): Promise<ReminderConfig> {
  let raw: string | null = null
  try {
    raw = await getSetting(sql, REMINDER_CONFIG_KEY)
  } catch (err) {
    console.error('[app-settings] reminder config read failed:', err)
    return loadReminderConfigFromEnv(env)
  }
  if (raw === null) return loadReminderConfigFromEnv(env)
  try {
    const parsed = validateReminderConfig(JSON.parse(raw))
    if (parsed.ok) return parsed.value
    console.error('[app-settings] stored reminder config invalid:', parsed.error)
  } catch (err) {
    console.error('[app-settings] reminder config parse failed:', err)
  }
  return loadReminderConfigFromEnv(env)
}

export async function setReminderConfig(
  sql: Sql,
  config: ReminderConfig,
): Promise<void> {
  await setSetting(sql, REMINDER_CONFIG_KEY, JSON.stringify(config))
}

// Resolve the live feed-migration campaign config. Same precedence shape as the
// reminder config above, minus the env layer: the two dates this carries are
// product decisions the team sets once in the back office, not per-environment
// knobs. A malformed/legacy row falls back to the defaults rather than throwing,
// so a bad row can't break the cron.
export async function getMigrationConfig(sql: Sql): Promise<MigrationConfig> {
  let raw: string | null = null
  try {
    raw = await getSetting(sql, MIGRATION_CONFIG_KEY)
  } catch (err) {
    console.error('[app-settings] migration config read failed:', err)
    return DEFAULT_MIGRATION_CONFIG
  }
  if (raw === null) return DEFAULT_MIGRATION_CONFIG
  try {
    const parsed = validateMigrationConfig(JSON.parse(raw))
    if (parsed.ok) return parsed.value
    console.error('[app-settings] stored migration config invalid:', parsed.error)
  } catch (err) {
    console.error('[app-settings] migration config parse failed:', err)
  }
  return DEFAULT_MIGRATION_CONFIG
}

export async function setMigrationConfig(
  sql: Sql,
  config: MigrationConfig,
): Promise<void> {
  await setSetting(sql, MIGRATION_CONFIG_KEY, JSON.stringify(config))
}
