// One-off admin grant/revoke. Admin access to the back office is driven by the
// "admin" role in an Auth0 user's app_metadata.roles; the Login Action mirrors
// that into the AUTH0_ROLES_CLAIM the server verifies (server/lib/session.ts).
//
// Usage (Bun auto-loads .env, so AUTH0_MANAGEMENT_* must be set there):
//   bun run scripts/set-admin.ts you@example.com           # grant admin
//   bun run scripts/set-admin.ts you@example.com --remove  # revoke admin
//
// The M2M app needs scopes: read:users update:users. After running, the user
// must log out and back in for the new role to appear in their token.

import { auth0MgmtBase, getAuth0ManagementToken } from '../server/auth0.js'

type Auth0User = {
  user_id: string
  app_metadata?: { roles?: string[] }
}

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

  const user = users[0]
  const roles = new Set(user.app_metadata?.roles ?? [])
  if (remove) roles.delete('admin')
  else roles.add('admin')
  const nextRoles = [...roles]

  const patch = await fetch(`${base}/users/${encodeURIComponent(user.user_id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ app_metadata: { roles: nextRoles } }),
  })
  if (!patch.ok) {
    console.error('Update failed:', patch.status, await patch.text())
    process.exit(1)
  }

  console.log(
    `${remove ? 'Revoked admin from' : 'Granted admin to'} ${email}. roles=[${nextRoles.join(', ')}]`,
  )
  console.log('They must log out and back in for the change to take effect in their token.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
