// Give every existing member the passwordless `email` identity that the login
// page's code prompt signs in against.
//
// New members get it at provisioning (server/lib/auth0-user.ts →
// linkEmailCodeLogin). Everyone provisioned before that, and anyone set up by
// hand in the dashboard (staff, admins, comps), has only a Database account,
// and with "Disable Sign Ups" on the passwordless connection Auth0 refuses to
// send them a code at all ("Public signup is disabled"). This walks every
// Database account and adds the missing identity. Idempotent, so it is also the
// repair for a member whose provisioning-time link failed.
//
// There is one Auth0 tenant, so this always writes to the live one. The banner
// says which; read it before typing --apply.
//
// The member list comes from Auth0's search index, which trails writes by a
// few seconds: a preview straight after --apply can still list someone just
// linked. The per-member step reads users-by-email, which is current, so
// re-applying is harmless.
//
// Usage (Bun auto-loads .env / .env.local):
//   bun run scripts/backfill-email-code-login.ts                    # preview
//   bun run scripts/backfill-email-code-login.ts --apply            # write
//   bun run scripts/backfill-email-code-login.ts --apply --limit 5  # staged
//   bun run scripts/backfill-email-code-login.ts --email a@b.com    # one member

import { getManagementClient } from '../server/auth0.js'
import { ensureEmailCodeLogin } from '../server/lib/auth0-user.js'

// Auth0's v3 user search stops returning results past this many, however they
// are paged. Past it, this script would silently miss members; switch to a
// users-export job instead.
const SEARCH_CAP = 1000

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const limit = Number(argValue('--limit') ?? '') || null
  const onlyEmail = argValue('--email')?.toLowerCase() ?? null
  const env = process.env as Record<string, string>

  const mgmt = getManagementClient(env)
  if (!mgmt) {
    console.error('Refusing to run: AUTH0_MANAGEMENT_CLIENT_ID/SECRET are required.')
    process.exit(1)
  }

  console.log(apply ? '=== APPLY (linking identities) ===' : '=== PREVIEW (no writes) ===')
  console.log(`  Auth0: ${env.AUTH0_TENANT_DOMAIN ?? '(default domain)'}`)
  if (limit) console.log(`  Limit: ${limit} member(s)`)
  if (onlyEmail) console.log(`  Only:  ${onlyEmail}`)
  console.log('')

  const query = onlyEmail
    ? `identities.connection:"Username-Password-Authentication" AND email:"${onlyEmail}"`
    : 'identities.connection:"Username-Password-Authentication"'
  const page = await mgmt.users.list({
    q: query,
    search_engine: 'v3',
    per_page: 100,
    include_totals: true,
    fields: 'user_id,email,identities',
    include_fields: true,
  })
  const total = page.response.total ?? 0
  if (total > SEARCH_CAP) {
    console.error(
      `Refusing to run: ${total} Database accounts exceeds the ${SEARCH_CAP}-result search cap.`,
    )
    process.exit(1)
  }

  const missing: string[] = []
  let covered = 0
  for await (const user of page) {
    const hasCode = (user.identities ?? []).some((i) => i.connection === 'email')
    if (hasCode) covered++
    else if (user.email) missing.push(user.email)
  }
  console.log(`${covered + missing.length} Database account(s): ${covered} already have a code login, ${missing.length} missing.`)

  const todo = limit === null ? missing : missing.slice(0, limit)
  let linked = 0
  const failed: string[] = []
  for (const email of todo) {
    if (!apply) {
      console.log(`  would link  ${email}`)
      continue
    }
    if (await ensureEmailCodeLogin(env, email)) {
      linked++
      console.log(`  linked      ${email}`)
    } else {
      failed.push(email)
      console.log(`  FAILED      ${email}`)
    }
  }

  if (todo.length < missing.length) {
    console.log(`\nNOTE: --limit ${limit} left ${missing.length - todo.length} member(s) unprocessed.`)
  }
  if (!apply) {
    console.log(`\nPreview only — ${todo.length} member(s) would be linked. Re-run with --apply.`)
    return
  }
  console.log(`\nLinked ${linked}, failed ${failed.length}.`)
  // Safe to re-run: members already linked cost nothing.
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
