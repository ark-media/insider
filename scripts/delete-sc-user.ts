// One-off SC user cleanup. Useful when a previous checkout left an SC user
// (and/or active subscription) lying around — typically because the buyer
// exists on the parent network, so deleting from the child-network UI doesn't
// remove them from `POST /users/search?family=all` (the search the activator
// uses), and the next attempt to create a Stripe-backed SC sub hits 409 /
// "This network limits users to only one active subscription at a time."
//
// Bun auto-loads .env, so SC_NETWORK_ID and SC_API_KEY must be set there.
//
// Usage:
//   bun run scripts/delete-sc-user.ts <email> [<email> ...]            # inspect only
//   bun run scripts/delete-sc-user.ts <email> [<email> ...] --delete   # actually delete

import { createScClient, findScUserByEmail } from '../server/lib/sc-client.js'

type ScError = Error & { status?: number; data?: unknown }

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const doDelete = args.includes('--delete')
  const emails = args.filter((a) => !a.startsWith('--')).map((e) => e.trim().toLowerCase())

  if (emails.length === 0) {
    console.error('Usage: bun run scripts/delete-sc-user.ts <email> [<email> ...] [--delete]')
    process.exit(1)
  }

  const env = process.env as Record<string, string>
  const sc = createScClient(env)

  for (const email of emails) {
    console.log(`\n— ${email}`)
    const user = await findScUserByEmail(sc, email)
    if (!user) {
      console.log('  not found (nothing to do)')
      continue
    }
    console.log(`  found user id=${user.id} email=${user.email}`)

    if (!doDelete) {
      console.log('  (inspect-only — rerun with --delete to remove)')
      continue
    }

    try {
      await sc.call('DELETE', `/users/${user.id}`)
      console.log(`  deleted user ${user.id}`)
    } catch (err) {
      const e = err as ScError
      console.error(`  delete failed: ${e.message}`, e.data ?? '')
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
