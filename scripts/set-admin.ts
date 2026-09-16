// One-off admin grant/revoke. Admin access to the back office is driven by the
// Auth0 RBAC role named "admin" (Auth0 Dashboard → Roles). The Login Action
// mirrors a user's assigned roles into the AUTH0_ROLES_CLAIM the server
// verifies (server/lib/session.ts):
//
//   const roles = event.authorization?.roles ?? [];
//   api.accessToken.setCustomClaim('https://ark-plus.xyz/roles', roles);
//   api.idToken.setCustomClaim('https://ark-plus.xyz/roles', roles);
//
// Usage (Bun auto-loads .env, so AUTH0_MANAGEMENT_* must be set there):
//   bun run scripts/set-admin.ts you@example.com           # assign admin
//   bun run scripts/set-admin.ts you@example.com --remove  # unassign admin
//
// The M2M app needs scopes: read:users read:roles update:users. After running,
// the user must log out and back in for the role to appear in their token.

import { getManagementClient } from '../server/auth0.js'

const ROLE_NAME = 'admin'

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  const remove = process.argv.includes('--remove')
  if (!email) {
    console.error('Usage: bun run scripts/set-admin.ts <email> [--remove]')
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

  // 1. Resolve the user.
  let userId: string | undefined
  try {
    const users = await mgmt.users.listUsersByEmail({ email })
    userId = users[0]?.user_id
  } catch (err) {
    console.error('User lookup failed:', err)
    process.exit(1)
  }
  if (!userId) {
    console.error(`No Auth0 user found for ${email}. They must sign in at least once first.`)
    process.exit(1)
  }

  // 2. Resolve the "admin" role id by name.
  let roleId: string | undefined
  try {
    const roles = await mgmt.roles.list({ name_filter: ROLE_NAME })
    roleId = roles.data.find((r) => r.name === ROLE_NAME)?.id
  } catch (err) {
    console.error('Role lookup failed:', err)
    process.exit(1)
  }
  if (!roleId) {
    console.error(`No Auth0 role named "${ROLE_NAME}". Create it in Auth0 → Roles first.`)
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
    console.error('Role update failed:', err)
    process.exit(1)
  }

  console.log(
    `${remove ? 'Removed' : 'Assigned'} role "${ROLE_NAME}" ${remove ? 'from' : 'to'} ${email}.`,
  )
  console.log('They must log out and back in for the change to take effect in their token.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
