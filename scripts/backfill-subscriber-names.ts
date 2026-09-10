// Backfill member names from the systems that already hold them.
//
// Most members migrated from Supporting Cast without a name, which is why every
// lifecycle email opens "Hi there,". Before asking anyone to type their name in
// the account page, harvest the ones we already have: a minority of records in
// SC, Stripe and Circle carry a real name, and that coverage is free.
//
// Three passes, in precedence order (first real name wins; a later pass never
// overwrites an earlier, better one):
//
//   A. Supporting Cast — loadAllMemberships returns first_name/last_name for the
//      whole roster. Highest quality: it IS the migrated roster.
//   B. Stripe — customer.name, for anyone who ever checked out.
//   C. Circle — community members, for Fold-first joiners. Lowest yield,
//      since most Circle members were created from a then-null Stripe name.
//
// Every candidate is filtered through shared/profile-name: all three systems
// store a name we manufactured from the email local part when we had nothing
// (findOrCreateScUser writes email.split('@')[0] into SC's first_name), so an
// unfiltered copy would just move junk from one store to another.
//
// Writes go to Auth0 (given_name/family_name — the name's home; Neon stores no
// PII), to Beehiiv custom fields (what campaigns actually personalize from), and
// to Circle — the one store where a stale name is read by other MEMBERS rather
// than by us, since a Circle record created without a name displays the whole
// email address as its first_name.
//
// NOTE: unlike scripts/backfill-membership.ts, this deliberately does NOT refuse
// to run against live Stripe — the whole point is to repair real migrated
// members. It prints which environment it is pointed at instead; read the banner
// before typing --apply.
//
// Usage (Bun auto-loads .env):
//   bun run scripts/backfill-subscriber-names.ts                     # preview
//   bun run scripts/backfill-subscriber-names.ts --apply             # write
//   bun run scripts/backfill-subscriber-names.ts --apply --limit 5   # staged
//   bun run scripts/backfill-subscriber-names.ts --email a@b.com     # one record

import Stripe from 'stripe'
import { neon } from '@neondatabase/serverless'
import { getManagementClient } from '../server/auth0.js'
import { updateAuth0Name } from '../server/lib/auth0-user.js'
import { syncSubscriberName } from '../server/lib/beehiiv-sync.js'
import { updateCircleMemberName } from '../server/entitlement.js'
import { createScV1Client, loadAllMemberships } from '../server/lib/sc-client.js'
import { hasRealName, splitFullName } from '../shared/profile-name.js'

type Env = Record<string, string | undefined>
type Source = 'supporting-cast' | 'stripe' | 'circle'
type Candidate = { first: string; last: string; source: Source }

// Auth0 Management sustains roughly 2 requests/second on a non-enterprise
// tenant, and each candidate costs a lookup plus a write. Three at a time with
// backoff keeps a multi-thousand-member run from 429ing halfway through.
const CONCURRENCY = 3

const argValue = (flag: string): string | null => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? (process.argv[i + 1] ?? null) : null
}

// Retry on Auth0/Beehiiv rate limits. Anything else fails fast — a genuine
// error should surface, not be retried into a longer run.
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let delayMs = 1000
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = (err as { statusCode?: number; status?: number })?.statusCode ??
        (err as { status?: number })?.status
      if (status !== 429 || attempt >= 4) throw err
      console.log(`    (429 on ${label}; retrying in ${delayMs}ms)`)
      await new Promise((r) => setTimeout(r, delayMs))
      delayMs *= 2
    }
  }
}

async function batched<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn))
  }
}

// Take a name only if it's one a human gave us. `hasRealName` rejects the
// email-local-part shape all three systems manufacture.
function candidateFrom(
  email: string,
  first: string | null | undefined,
  last: string | null | undefined,
  source: Source,
): Candidate | null {
  const givenName = (first ?? '').trim()
  const familyName = (last ?? '').trim()
  if (!hasRealName({ givenName, familyName, email })) return null
  return { first: givenName, last: familyName, source }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const limit = Number(argValue('--limit') ?? '') || null
  const onlyEmail = argValue('--email')?.toLowerCase() ?? null
  const env = process.env as Env

  const mgmt = getManagementClient(env as Record<string, string>)
  if (!mgmt) {
    console.error('Refusing to run: AUTH0_MANAGEMENT_CLIENT_ID/SECRET are required.')
    process.exit(1)
  }
  if (!env.DATABASE_URL) {
    console.error('Refusing to run: DATABASE_URL is required (Beehiiv mirror).')
    process.exit(1)
  }
  const sql = neon(env.DATABASE_URL)
  const stripeKey = env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : null

  // Say plainly which environment this run touches — this script is allowed to
  // write to production, so the operator has to be able to see that.
  console.log(apply ? '=== APPLY (writing names) ===' : '=== PREVIEW (no writes) ===')
  console.log(`  Stripe:  ${stripeKey ? (stripeKey.startsWith('sk_test_') ? 'TEST mode' : 'LIVE mode') : '(not configured — skipping pass B)'}`)
  console.log(`  Auth0:   ${env.AUTH0_TENANT_DOMAIN ?? '(default domain)'}`)
  console.log(`  Beehiiv: ${env.BEEHIIV_PUBLICATION_ID_ARK_DAILY ?? '(not configured — no campaign sync)'}`)
  if (limit) console.log(`  Limit:   ${limit} candidate(s)`)
  if (onlyEmail) console.log(`  Only:    ${onlyEmail}`)
  console.log('')

  // Passes that errored rather than legitimately having nothing to offer. A run
  // that lost a whole source is not a clean run, and the exit code says so.
  const passFailures: string[] = []

  // email → best candidate found so far.
  const found = new Map<string, Candidate>()
  const offer = (email: string | null | undefined, c: Candidate | null): void => {
    const key = (email ?? '').trim().toLowerCase()
    if (!key || !c) return
    if (onlyEmail && key !== onlyEmail) return
    if (found.has(key)) return // earlier pass wins
    found.set(key, c)
  }

  // --- Pass A: Supporting Cast ------------------------------------------------
  console.log('Pass A — Supporting Cast roster')
  try {
    const members = await loadAllMemberships(createScV1Client(env as Record<string, string>))
    let hits = 0
    for (const m of members) {
      const before = found.size
      // SC's first_name held the whole name whenever the user was created from a
      // single hint, so split it when nothing sits in last_name — otherwise
      // "Hannah Waxman" lands in Auth0's given_name and every greeting in the
      // system reads "Hi Hannah Waxman,". Pass B already splits Stripe's name;
      // this is the higher-precedence pass, so it decides the whole roster.
      const { first, last } = (m.last_name ?? '').trim()
        ? { first: m.first_name, last: m.last_name }
        : splitFullName(m.first_name)
      offer(m.email, candidateFrom(m.email, first, last, 'supporting-cast'))
      if (found.size > before) hits += 1
    }
    console.log(`  scanned ${members.length}, usable names ${hits}`)
  } catch (err) {
    console.log(`  ! FAILED — ${err instanceof Error ? err.message : String(err)}`)
    console.log('    Pass A contributed nothing; this is the highest-yield source.')
    passFailures.push('supporting-cast')
  }

  // --- Pass B: Stripe customers ----------------------------------------------
  console.log('\nPass B — Stripe customers')
  if (!stripe) {
    console.log('  (STRIPE_SECRET_KEY unset — skipped)')
  } else {
    let scanned = 0
    let hits = 0
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      scanned += 1
      if (!customer.email) continue
      const { first, last } = splitFullName(customer.name)
      const before = found.size
      offer(customer.email, candidateFrom(customer.email, first, last, 'stripe'))
      if (found.size > before) hits += 1
    }
    console.log(`  scanned ${scanned}, usable names ${hits}`)
  }

  // --- Pass C: Circle community members --------------------------------------
  console.log('\nPass C — Circle community members')
  // CIRCLE_ADMIN_API_TOKEN, because the URL below is Admin **v2**. This used to
  // read CIRCLE_API_TOKEN on the grounds that server/entitlement.ts did — which
  // was true, and was the bug: that is an Admin v1 token, Circle 401s it on
  // /api/admin/v2/*, and this pass threw on its first page every time it ran.
  const circleToken = env.CIRCLE_ADMIN_API_TOKEN
  if (!circleToken) {
    console.log('  (CIRCLE_ADMIN_API_TOKEN unset — skipped)')
  } else {
    let scanned = 0
    let hits = 0
    try {
      for (let page = 1; page <= 100; page += 1) {
        const res = await fetch(
          `https://app.circle.so/api/admin/v2/community_members?per_page=100&page=${page}`,
          { headers: { Authorization: `Bearer ${circleToken}` } },
        )
        if (!res.ok) throw new Error(`Circle members list ${res.status}`)
        const body = (await res.json()) as {
          records?: { email?: string; name?: string; first_name?: string; last_name?: string }[]
          has_next_page?: boolean
        }
        const records = body.records ?? []
        for (const r of records) {
          scanned += 1
          if (!r.email) continue
          // Circle exposes either split parts or a single display name.
          const split = splitFullName(r.name)
          const before = found.size
          offer(
            r.email,
            candidateFrom(r.email, r.first_name ?? split.first, r.last_name ?? split.last, 'circle'),
          )
          if (found.size > before) hits += 1
        }
        if (records.length < 100 || body.has_next_page === false) break
      }
      console.log(`  scanned ${scanned}, usable names ${hits}`)
    } catch (err) {
      // Loud, and flagged in the summary. A 401 here used to print as "skipped"
      // and exit 0, which is indistinguishable from "Circle had nothing to add"
      // — an operator would read a silently empty pass as a clean run.
      console.log(`  ! FAILED — ${err instanceof Error ? err.message : String(err)}`)
      console.log('    Pass C contributed nothing; names from Circle are missing.')
      passFailures.push('circle')
    }
  }

  // --- Apply -----------------------------------------------------------------
  console.log(`\nResolving ${found.size} candidate(s) against Auth0`)
  // Source breakdown describes what the three passes FOUND, so it always sums to
  // the candidate count — counting it at the write stage instead made a preview
  // run report "26 candidates / 0 from every source", which reads as a bug.
  const bySource: Record<Source, number> = { 'supporting-cast': 0, stripe: 0, circle: 0 }
  for (const c of found.values()) bySource[c.source] += 1

  const summary = {
    noAuth0User: 0,
    alreadyNamed: 0,
    updated: 0,
    beehiivSynced: 0,
    circleSynced: 0,
    failed: 0,
  }
  let writes = 0

  // --limit caps candidates *processed*, not just written: each one costs an
  // Auth0 lookup, so limiting only the writes would leave a preview run making
  // thousands of Management calls to produce a dry-run report.
  const all = [...found.entries()]
  const entries = limit === null ? all : all.slice(0, limit)
  const skippedByLimit = all.length - entries.length

  await batched(entries, CONCURRENCY, async ([email, candidate]) => {
    let user: { user_id?: string; given_name?: string; family_name?: string } | undefined
    try {
      const users = await withRetry('users-by-email', () =>
        mgmt.users.listUsersByEmail({ email }),
      )
      // The post-merge primary is the DB-connection (auth0|…) identity when
      // present, else the first — same rule as backfill-membership.
      user = users.find((u) => u.user_id?.startsWith('auth0|')) ?? users[0]
    } catch (err) {
      console.log(`  ! ${email}: Auth0 lookup failed — ${err instanceof Error ? err.message : err}`)
      summary.failed += 1
      return
    }

    if (!user?.user_id) {
      summary.noAuth0User += 1
      return
    }
    // Never overwrite a name the member already gave us.
    if (hasRealName({ givenName: user.given_name, familyName: user.family_name, email })) {
      summary.alreadyNamed += 1
      return
    }
    writes += 1

    const label = `${candidate.first}${candidate.last ? ` ${candidate.last}` : ''}`
    console.log(`  ${apply ? '+' : '·'} ${email} → ${label} (${candidate.source})`)
    if (!apply) return

    try {
      const ok = await withRetry('users-update', () =>
        updateAuth0Name(env as Record<string, string>, user!.user_id!, {
          givenName: candidate.first,
          familyName: candidate.last,
        }),
      )
      if (!ok) {
        summary.failed += 1
        return
      }
      summary.updated += 1
    } catch (err) {
      console.log(`  ! ${email}: Auth0 write failed — ${err instanceof Error ? err.message : err}`)
      summary.failed += 1
      return
    }

    // Campaign personalization is the point of the exercise, but a Beehiiv
    // failure must not lose the Auth0 write we just made.
    try {
      // Counts the writes that actually happened. syncSubscriberName is a no-op
      // when Beehiiv isn't configured or the member has no subscription, and
      // neither throws — so incrementing unconditionally reported "synced to
      // Beehiiv: 2,847" for a run that wrote nothing, contradicting the
      // "(not configured)" banner printed above it.
      const synced = await withRetry('beehiiv-name', () =>
        syncSubscriberName({ env: env as Record<string, string>, sql }, email, {
          first: candidate.first,
          // undefined, not null: a harvested mononym means we never learned a
          // surname, which is not a licence to delete one Beehiiv already has.
          last: candidate.last || undefined,
        }),
      )
      if (synced) summary.beehiivSynced += 1
    } catch (err) {
      console.log(`  ~ ${email}: Beehiiv sync failed — ${err instanceof Error ? err.message : err}`)
    }

    // Circle is where a stale name is read by other MEMBERS rather than by us:
    // a Circle record we created without a name displays the whole email
    // address as its first_name. Same soft handling as Beehiiv — already
    // no-ops (returns false) for a member with no Circle record, which is
    // most of the roster, so this is only counted when a write really landed.
    try {
      const synced = await withRetry('circle-name', () =>
        updateCircleMemberName(env as Record<string, string>, email, {
          first: candidate.first,
          // undefined, not null: a harvested mononym means we never learned a
          // surname, which is not a licence to delete one Circle already has.
          last: candidate.last || undefined,
        }),
      )
      if (synced) summary.circleSynced += 1
    } catch (err) {
      console.log(`  ~ ${email}: Circle sync failed — ${err instanceof Error ? err.message : err}`)
    }
  })

  console.log('\n--- Summary ---')
  console.log(`  candidates found:   ${found.size}`)
  console.log(`    from SC:          ${bySource['supporting-cast']}`)
  console.log(`    from Stripe:      ${bySource.stripe}`)
  console.log(`    from Circle:      ${bySource.circle}`)
  console.log(`  processed:          ${entries.length}`)
  console.log(`  no Auth0 user:      ${summary.noAuth0User}`)
  console.log(`  already named:      ${summary.alreadyNamed}`)
  console.log(`  updated in Auth0:   ${summary.updated}`)
  console.log(`  synced to Beehiiv:  ${summary.beehiivSynced}`)
  console.log(`  synced to Circle:   ${summary.circleSynced}`)
  console.log(`  failed:             ${summary.failed}`)
  if (skippedByLimit > 0) {
    console.log(`  NOTE: --limit ${limit} left ${skippedByLimit} candidate(s) unprocessed.`)
  }
  console.log(
    apply
      ? '\nDone. Members still without a name will be prompted on /account.'
      : `\nPreview only — ${writes} name(s) would be written. Re-run with --apply.`,
  )
  if (passFailures.length > 0) {
    console.error(
      `\nINCOMPLETE: ${passFailures.join(', ')} failed — re-run once fixed, or those names stay missing.`,
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(
    '[backfill-subscriber-names] failed:',
    err instanceof Error ? err.message : err,
  )
  process.exit(1)
})
