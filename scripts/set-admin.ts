// One-off admin grant/revoke. Admin access to the back office is driven by the
// Auth0 RBAC role named "admin" (Auth0 Dashboard → Roles). The Login Action
// mirrors a user's assigned roles into the AUTH0_ROLES_CLAIM the server
// verifies (server/lib/session.ts):
//
//   const roles = event.authorization?.roles ?? [];
//   api.accessToken.setCustomClaim('https://ark-plus.xyz/roles', roles);
//   api.idToken.setCustomClaim('https://ark-plus.xyz/roles', roles);
//
// There is one Auth0 tenant, so this always writes to the live one. The banner
// says which tenant and which account; read it before typing --apply.
//
// Usage (Bun auto-loads .env, so AUTH0_MANAGEMENT_* must be set there):
//   bun run scripts/set-admin.ts you@example.com                    # preview
//   bun run scripts/set-admin.ts you@example.com --apply            # assign admin
//   bun run scripts/set-admin.ts you@example.com --remove --apply   # unassign admin
//   bun run scripts/set-admin.ts you@example.com --user-id 'auth0|…' --apply
//
// An address can belong to more than one Auth0 account (a Database account and
// an unlinked social one). The preview lists them all; with more than one,
// --apply refuses until --user-id names the account to change.
//
// The M2M app needs scopes: read:users read:roles update:users. After running,
// the user must log out and back in for the role to appear in their token.

import { getManagementClient } from '../server/auth0.js'

const ROLE_NAME = 'admin'

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? (process.argv[i + 1] ?? null) : null
}

// The SDK's error objects carry the whole request, Authorization header
// included. Log the status and message only, never the object.
function describeError(err: unknown): string {
  const status =
    typeof err === 'object' && err !== null && 'statusCode' in err
      ? (err as { statusCode?: unknown }).statusCode
      : undefined
  const message = err instanceof Error ? err.message : String(err)
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message
}

async function main(): Promise<void> {
  const first = process.argv[2]
  const email = first && !first.startsWith('--') ? first.trim().toLowerCase() : undefined
  const remove = process.argv.includes('--remove')
  const apply = process.argv.includes('--apply')
  const wantedUserId = argValue('--user-id')
  if (!email) {
    console.error(
      'Usage: bun run scripts/set-admin.ts <email> [--remove] [--user-id <id>] [--apply]',
    )
    process.exit(1)
  }

  const env = process.env as Record<string, string>
  const mgmt = getManagementClient(env)
  if (!mgmt) {
    console.error(
      'Could not build an Auth0 Management client. Set AUTH0_MANAGEMENT_CLIENT_ID, ' +
        'AUTH0_MANAGEMENT_CLIENT_SECRET (and AUTH0_TENANT_DOMAIN) in .env.',
    )
    process.exit(1)
  }

  const action = remove ? `REMOVE role "${ROLE_NAME}" from` : `ASSIGN role "${ROLE_NAME}" to`
  console.log(apply ? '=== APPLY (changing a role) ===' : '=== PREVIEW (no writes) ===')
  console.log(`  Auth0:  ${env.AUTH0_TENANT_DOMAIN ?? '(default domain)'}`)
  console.log(`  Action: ${action} ${email}`)
  console.log('')

  // 1. Resolve the user.
  let matches: { user_id?: string; identities?: { connection?: string }[] }[] = []
  try {
    matches = await mgmt.users.listUsersByEmail({ email })
  } catch (err) {
    console.error('User lookup failed:', describeError(err))
    process.exit(1)
  }
  if (matches.length === 0) {
    console.error(`No Auth0 user found for ${email}. They must sign in at least once first.`)
    process.exit(1)
  }
  console.log(`${matches.length} Auth0 account(s) for ${email}:`)
  for (const u of matches) {
    const connections = (u.identities ?? []).map((i) => i.connection).join(', ')
    console.log(`  ${u.user_id}  (${connections || 'no identities listed'})`)
  }
  const userId = wantedUserId
    ? matches.find((u) => u.user_id === wantedUserId)?.user_id
    : matches[0]?.user_id
  if (!userId) {
    console.error(`--user-id ${wantedUserId} is not one of the accounts above.`)
    process.exit(1)
  }
  console.log(`Target: ${userId}`)

  // 2. Resolve the "admin" role id by name.
  let roleId: string | undefined
  try {
    const roles = await mgmt.roles.list({ name_filter: ROLE_NAME })
    roleId = roles.data.find((r) => r.name === ROLE_NAME)?.id
  } catch (err) {
    console.error('Role lookup failed:', describeError(err))
    process.exit(1)
  }
  if (!roleId) {
    console.error(`No Auth0 role named "${ROLE_NAME}". Create it in Auth0 → Roles first.`)
    process.exit(1)
  }

  if (!apply) {
    console.log(
      `\nPreview only — would ${remove ? 'remove' : 'assign'} role "${ROLE_NAME}" ` +
        `(${roleId}) ${remove ? 'from' : 'to'} ${userId}. Re-run with --apply.`,
    )
    return
  }
  if (matches.length > 1 && !wantedUserId) {
    console.error(
      `\nRefusing to apply: ${email} has ${matches.length} accounts. ` +
        'Re-run with --user-id <id> naming the one to change.',
    )
    process.exit(1)
  }

  // 3. Assign or remove the role. Both endpoints return 204 on success and
  //    are idempotent (re-assigning an existing role is a no-op).
  try {
    if (remove) {
      await mgmt.users.roles.delete(userId, { roles: [roleId] })
    } else {
      await mgmt.users.roles.assign(userId, { roles: [roleId] })
    }
  } catch (err) {
    console.error('Role update failed:', describeError(err))
    process.exit(1)
  }

  console.log(
    `\n${remove ? 'Removed' : 'Assigned'} role "${ROLE_NAME}" ${remove ? 'from' : 'to'} ${email} (${userId}).`,
  )
  console.log('They must log out and back in for the change to take effect in their token.')
}

main().catch((err) => {
  console.error(describeError(err))
  process.exit(1)
})
