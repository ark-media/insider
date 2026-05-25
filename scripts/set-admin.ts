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

import { auth0MgmtBase, getAuth0ManagementToken } from '../server/auth0.js'

const ROLE_NAME = 'admin'

type Auth0User = { user_id: string }
type Auth0Role = { id: string; name: string }

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  const remove = process.argv.includes('--remove')
  if (!email) {
    console.error('Usage: bun run scripts/set-admin.ts <email> [--remove]')
    process.exit(1)
  }

  const env = process.env as Record<string, string>
  const token = await getAuth0ManagementToken(env)
  if (!token) {
    console.error(
      'Could not get an Auth0 Management token. Set AUTH0_MANAGEMENT_CLIENT_ID, ' +
        'AUTH0_MANAGEMENT_CLIENT_SECRET (and AUTH0_TENANT_DOMAIN) in .env.',
    )
    process.exit(1)
  }

  const base = auth0MgmtBase(env)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  // 1. Resolve the user.
  const lookup = await fetch(
    `${base}/users-by-email?email=${encodeURIComponent(email)}`,
    { headers },
  )
  if (!lookup.ok) {
    console.error('User lookup failed:', lookup.status, await lookup.text())
    process.exit(1)
  }
  const users = (await lookup.json()) as Auth0User[]
  if (users.length === 0) {
    console.error(`No Auth0 user found for ${email}. They must sign in at least once first.`)
    process.exit(1)
  }
  const userId = users[0].user_id

  // 2. Resolve the "admin" role id by name.
  const rolesRes = await fetch(`${base}/roles?name_filter=${ROLE_NAME}`, { headers })
  if (!rolesRes.ok) {
    console.error('Role lookup failed:', rolesRes.status, await rolesRes.text())
    process.exit(1)
  }
  const roles = (await rolesRes.json()) as Auth0Role[]
  const role = roles.find((r) => r.name === ROLE_NAME)
  if (!role) {
    console.error(`No Auth0 role named "${ROLE_NAME}". Create it in Auth0 → Roles first.`)
    process.exit(1)
  }

  // 3. Assign or remove the role. Both endpoints return 204 on success and
  //    are idempotent (re-assigning an existing role is a no-op).
  const res = await fetch(`${base}/users/${encodeURIComponent(userId)}/roles`, {
    method: remove ? 'DELETE' : 'POST',
    headers,
    body: JSON.stringify({ roles: [role.id] }),
  })
  if (!res.ok) {
    console.error('Role update failed:', res.status, await res.text())
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
