// Create the Beehiiv custom-field definitions that hold a subscriber's name.
//
// Beehiiv has no native name field — a name is a *custom field*, and the
// definition must exist on the publication before any subscription write can
// reference it. The API is explicit about the failure mode: "The custom fields
// must already exist for the publication. Any new custom fields here will be
// discarded." So without this script the name push looks like it succeeds and
// silently stores nothing.
//
// Run once per publication. Idempotent: an existing field is reported and left
// alone rather than duplicated. This is a script rather than a dashboard click
// so the field names stay pinned to the constants the sync code writes
// (FIELD_FIRST_NAME / FIELD_LAST_NAME in server/lib/beehiiv-sync.ts).
//
// Usage (Bun auto-loads .env; BEEHIIV_API_KEY and a publication id must be set):
//   bun run scripts/beehiiv-provision-custom-fields.ts          # preview
//   bun run scripts/beehiiv-provision-custom-fields.ts --apply  # create

import { FIELD_FIRST_NAME, FIELD_LAST_NAME } from '../server/lib/beehiiv-sync.js'

type Env = Record<string, string | undefined>

const FIELDS = [FIELD_FIRST_NAME, FIELD_LAST_NAME]

type CustomField = { id?: string; display?: string; kind?: string }

function publicationId(env: Env): string {
  // The two slug-scoped vars point at the same shared publication (see
  // server/lib/beehiiv-sync.ts); accept either.
  const id =
    env.BEEHIIV_PUBLICATION_ID_ARK_DAILY || env.BEEHIIV_PUBLICATION_ID_MEMBERS_LETTER
  if (!id || !/^pub_[A-Za-z0-9-]+$/.test(id)) {
    console.error(
      'Refusing to run: set BEEHIIV_PUBLICATION_ID_ARK_DAILY (or _MEMBERS_LETTER) to a pub_… id.',
    )
    process.exit(1)
  }
  return id
}

function apiKey(env: Env): string {
  const token = env.BEEHIIV_API_KEY
  if (!token) {
    console.error('Refusing to run: BEEHIIV_API_KEY is not set.')
    process.exit(1)
  }
  return token
}

async function listCustomFields(pubId: string, token: string): Promise<CustomField[]> {
  const all: CustomField[] = []
  for (let page = 1; page <= 20; page += 1) {
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${pubId}/custom_fields?limit=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) {
      throw new Error(`list custom_fields failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as { data?: CustomField[] }
    const data = body.data ?? []
    all.push(...data)
    if (data.length < 100) break
  }
  return all
}

async function createCustomField(
  pubId: string,
  token: string,
  display: string,
): Promise<void> {
  const res = await fetch(
    `https://api.beehiiv.com/v2/publications/${pubId}/custom_fields`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'string', display }),
    },
  )
  if (!res.ok) {
    throw new Error(`create "${display}" failed: ${res.status} ${await res.text()}`)
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const env = process.env as Env
  const pubId = publicationId(env)
  const token = apiKey(env)

  console.log(apply ? '=== APPLY (creating fields) ===' : '=== PREVIEW (no writes) ===')
  console.log(`publication: ${pubId}\n`)

  const existing = await listCustomFields(pubId, token)
  const have = new Set(existing.map((f) => (f.display ?? '').trim().toLowerCase()))

  let created = 0
  for (const display of FIELDS) {
    if (have.has(display.toLowerCase())) {
      console.log(`  ✓ "${display}" already exists`)
      continue
    }
    if (apply) {
      await createCustomField(pubId, token, display)
      console.log(`  + created "${display}"`)
    } else {
      console.log(`  + would create "${display}"`)
    }
    created += 1
  }

  console.log(
    apply
      ? `\nDone. ${created} field(s) created.`
      : `\nPreview only — ${created} field(s) would be created. Re-run with --apply.`,
  )
}

main().catch((err) => {
  console.error(
    '[beehiiv-provision-custom-fields] failed:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
