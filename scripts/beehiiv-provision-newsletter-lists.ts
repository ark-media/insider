// Create the publication's two Beehiiv newsletter lists, and backfill The
// Current with the readers who were subscribed before it was a list.
//
// The Current and the AMA emails are independent lists on one publication (see
// newsletterListIds in server/lib/beehiiv-sync.ts):
//   - The Current      — auto-subscribe ON, so every new subscription joins it
//   - Ark+ AMA Links   — auto-subscribe OFF; the site adds Ark+ members who opt in
// Lists are matched by slug, so the script is idempotent. It prints the env
// lines the app needs (BEEHIIV_LIST_ID_THE_CURRENT / BEEHIIV_LIST_ID_AMA).
//
// --backfill: auto-subscribe only covers subscriptions created AFTER the list,
// so everyone already receiving the newsletter is added to The Current. Run it
// before deploying the list-aware app: until then the site would show those
// readers as not subscribed, and a post sent to the list would skip them.
//
// Usage (Bun auto-loads .env; BEEHIIV_API_KEY and a publication id must be set):
//   bun run scripts/beehiiv-provision-newsletter-lists.ts                       # preview
//   bun run scripts/beehiiv-provision-newsletter-lists.ts --apply               # create lists
//   bun run scripts/beehiiv-provision-newsletter-lists.ts --backfill            # preview backfill
//   bun run scripts/beehiiv-provision-newsletter-lists.ts --backfill --apply    # backfill

type Env = Record<string, string | undefined>

type ListSpec = {
  envKey: string
  slug: string
  name: string
  description: string
  auto_subscribe: boolean
}

const LISTS: ListSpec[] = [
  {
    envKey: 'BEEHIIV_LIST_ID_THE_CURRENT',
    slug: 'the-current',
    name: 'The Current',
    description: 'The weekly newsletter from Ark Media.',
    auto_subscribe: true,
  },
  {
    envKey: 'BEEHIIV_LIST_ID_AMA',
    slug: 'ark-plus-ama-links',
    name: 'Ark+ AMA Links',
    description: 'The private YouTube link to each Ark+ AMA episode, as soon as it is out.',
    auto_subscribe: false,
  },
]

type NewsletterList = { id: string; slug: string; name: string; subscriber_count?: number }
type Subscription = { id: string; email: string; newsletter_list_ids?: string[] }

function requireEnv(env: Env): { pubId: string; token: string } {
  const pubId = env.BEEHIIV_PUBLICATION_ID_ARK_DAILY
  const token = env.BEEHIIV_API_KEY
  if (!pubId || !/^pub_[A-Za-z0-9-]+$/.test(pubId)) {
    console.error('Refusing to run: set BEEHIIV_PUBLICATION_ID_ARK_DAILY to a pub_… id.')
    process.exit(1)
  }
  if (!token) {
    console.error('Refusing to run: BEEHIIV_API_KEY is not set.')
    process.exit(1)
  }
  return { pubId, token }
}

async function api<T>(
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${await res.text()}`)
    }
    return (await res.json()) as T
  }
}

async function listLists(pubId: string, token: string): Promise<NewsletterList[]> {
  const all: NewsletterList[] = []
  for (let page = 1; page <= 20; page += 1) {
    const body = await api<{ data?: NewsletterList[] }>(
      token,
      `https://api.beehiiv.com/v2/publications/${pubId}/newsletter_lists?limit=100&page=${page}`,
    )
    const data = body.data ?? []
    all.push(...data)
    if (data.length < 100) break
  }
  return all
}

async function provisionLists(
  pubId: string,
  token: string,
  apply: boolean,
): Promise<Map<string, string>> {
  const existing = await listLists(pubId, token)
  const ids = new Map<string, string>()
  for (const spec of LISTS) {
    const found = existing.find((l) => l.slug === spec.slug)
    if (found) {
      console.log(`  ✓ "${spec.name}" exists (${found.id}, ${found.subscriber_count ?? '?'} subscribers)`)
      ids.set(spec.envKey, found.id)
      continue
    }
    if (!apply) {
      console.log(`  + would create "${spec.name}" (auto-subscribe ${spec.auto_subscribe ? 'on' : 'off'})`)
      continue
    }
    const { envKey: _envKey, ...body } = spec
    const created = await api<{ data: NewsletterList }>(
      token,
      `https://api.beehiiv.com/v2/publications/${pubId}/newsletter_lists`,
      { method: 'POST', body },
    )
    console.log(`  + created "${spec.name}" (${created.data.id})`)
    ids.set(spec.envKey, created.data.id)
  }
  return ids
}

async function backfillCurrent(
  pubId: string,
  token: string,
  currentId: string,
  apply: boolean,
): Promise<void> {
  let missing = 0
  let seen = 0
  for (const status of ['active', 'pending']) {
    let cursor: string | null = null
    do {
      const qs = new URLSearchParams({ status, limit: '100' })
      qs.append('expand[]', 'newsletter_lists')
      if (cursor) qs.set('cursor', cursor)
      const page: { data?: Subscription[]; next_cursor?: string | null; has_more?: boolean } =
        await api(token, `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions?${qs}`)
      for (const sub of page.data ?? []) {
        seen += 1
        if (sub.newsletter_list_ids?.includes(currentId)) continue
        missing += 1
        if (apply) {
          await api(token, `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions/${sub.id}`, {
            method: 'PUT',
            body: { newsletter_list_ids: [currentId] },
          })
        }
      }
      cursor = page.has_more ? (page.next_cursor ?? null) : null
    } while (cursor)
  }
  console.log(
    apply
      ? `\nBackfill done: ${missing} of ${seen} active/pending subscriptions added to The Current.`
      : `\nBackfill preview: ${missing} of ${seen} active/pending subscriptions are not on The Current. Re-run with --apply.`,
  )
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const backfill = process.argv.includes('--backfill')
  const { pubId, token } = requireEnv(process.env as Env)

  console.log(apply ? '=== APPLY ===' : '=== PREVIEW (no writes) ===')
  console.log(`publication: ${pubId}\n`)

  const ids = await provisionLists(pubId, token, apply && !backfill)
  if (ids.size === LISTS.length) {
    console.log('\nEnv:')
    for (const [key, id] of ids) console.log(`  ${key}=${id}`)
  }

  if (backfill) {
    const currentId = ids.get('BEEHIIV_LIST_ID_THE_CURRENT')
    if (!currentId) {
      console.error('\nNo "The Current" list yet — run with --apply (no --backfill) first.')
      process.exit(1)
    }
    await backfillCurrent(pubId, token, currentId, apply)
  }
}

main().catch((err) => {
  console.error(
    '[beehiiv-provision-newsletter-lists] failed:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
