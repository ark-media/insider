// ICMB → Ark+ subscription migration — moves an existing Inside Call me Back
// subscription (the Supercast-era products) onto the catalog's Ark+ product IN
// PLACE.
//
// Why in place, not a new subscription: the webhook only recognises a
// subscription whose product carries the catalog's `entitlements` metadata
// (catalogTierOfSubscription), and the ICMB welcome offer only admits an Ark+
// subscription CREATED before launch (welcome-offer.ts blockFor). Keeping the
// subscription keeps its created date, customer, card, billing date and any
// discount.
//
// What the swap does: the one subscription item is repointed at an inline
// price (price_data) on the Ark+ product, carrying the member's OWN amount,
// currency and interval — so what they pay is unchanged — with
// proration_behavior 'none', so nothing is invoiced. The item keeps its id, so
// its billing period and any item-level discount stay put.
//
// Markers written onto the subscription:
//   plan                     monthly | yearly — activation reads this; without
//                            it every migrated member is recorded as yearly
//   icmb_migrated_at         ISO timestamp
//   icmb_from_price          the legacy price id (what --revert restores)
//   icmb_from_product        the legacy product id
//
// The swap fires `customer.subscription.updated`. Wherever a webhook endpoint
// for this Stripe mode is listening, that provisions the member: Auth0 login,
// Beehiiv premium, the membership row, and the welcome email.
//
// Test mode by default. STRIPE_SECRET_KEY must start with `sk_test_` unless
// `--live` is passed, and a live write additionally needs CONFIRM_LIVE_ACCOUNT
// set to the live account id, checked against the key before anything is
// written.
//
// Staff move to the Bundle ("Ark+ & The Fold") instead, via --bundle /
// --bundle-file. The webhook writes the membership row from the subscription's
// product, so a staffer moved to Ark+ would have their comped Bundle row
// overwritten down to Ark+; on the Bundle product the row stays Bundle. They
// keep their own amount and any discount, like everyone else.
//
// Targets — one of:
//   (none)                   inventory: every non-catalog product with its count
//                            of live subscriptions, to pick the --product ids
//   --email=<addr>           that customer's subscriptions (repeatable)
//   --product=<prod_…>       every subscription on that legacy product
//                            (repeatable; catalog products are refused). With
//                            --revert, every subscription migrated OFF it.
// Options:
//   --bundle=<addr>          move this customer to the Bundle, not Ark+ (staff)
//   --bundle-file=<path>     one email per line, # comments allowed
//   --exclude=<addr>         skip this customer (repeatable)
//   --exclude-file=<path>    same format as --bundle-file
//   --limit=<n>              stop after n subscriptions — migrated ones leave
//                            the legacy product, so re-running continues
//   --apply                  write (otherwise preview)
//   --revert                 undo: restore icmb_from_price, clear the markers
//
// Usage:
//   bun run scripts/migrate-icmb-subscriptions.ts                             # inventory
//   bun run scripts/migrate-icmb-subscriptions.ts --email=a@b.com           # preview
//   bun run scripts/migrate-icmb-subscriptions.ts --email=a@b.com --apply
//   bun run scripts/migrate-icmb-subscriptions.ts --email=a@b.com --revert --apply
//   bun run scripts/migrate-icmb-subscriptions.ts --product=prod_… --bundle-file=staff.txt --limit=10
//   STRIPE_SECRET_KEY=sk_live_… bun run scripts/migrate-icmb-subscriptions.ts --live --product=prod_…
//   STRIPE_SECRET_KEY=sk_live_… CONFIRM_LIVE_ACCOUNT=acct_… \
//     bun run scripts/migrate-icmb-subscriptions.ts --live --product=prod_… --bundle-file=staff.txt --apply

import Stripe from 'stripe'

const MIGRATED_AT = 'icmb_migrated_at'
const FROM_PRICE = 'icmb_from_price'
const FROM_PRODUCT = 'icmb_from_product'

// Statuses worth moving. An ended or incomplete subscription has nothing to
// keep billing.
const MIGRATABLE_STATUSES = new Set(['active', 'trialing', 'past_due'])

// --- Guards (same contract as stripe-catalog.ts) ---------------------------

function assertKeyMode(key: string | undefined, live: boolean): asserts key is string {
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set.')
    process.exit(1)
  }
  const prefix = live ? 'sk_live_' : 'sk_test_'
  if (!key.startsWith(prefix)) {
    console.error(
      live
        ? 'Refusing to run: --live was passed but STRIPE_SECRET_KEY is not a live key (sk_live_…).'
        : 'Refusing to run: STRIPE_SECRET_KEY is not a test key. Pass --live for live mode.',
    )
    process.exit(1)
  }
}

async function assertLiveAccount(stripe: Stripe): Promise<void> {
  const expected = process.env.CONFIRM_LIVE_ACCOUNT
  const account = await stripe.accounts.retrieveCurrent()
  if (!expected || expected !== account.id) {
    console.error(
      `Refusing to write to LIVE: this key belongs to ${account.id}. ` +
        'Re-run with CONFIRM_LIVE_ACCOUNT set to that id to confirm.',
    )
    process.exit(1)
  }
}

// --- Helpers ---------------------------------------------------------------

function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null
  return typeof ref === 'string' ? ref : ref.id
}

function planOf(price: Stripe.Price): 'monthly' | 'yearly' | null {
  const r = price.recurring
  if (!r || r.interval_count !== 1) return null
  if (r.interval === 'month') return 'monthly'
  if (r.interval === 'year') return 'yearly'
  return null
}

function money(amount: number | null, currency: string): string {
  return amount == null ? 'n/a' : `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`
}

function date(sec: number | null | undefined): string {
  return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : 'n/a'
}

// The catalog's Ark+ product, found the way stripe-catalog.ts addresses it.
async function findCatalogProduct(stripe: Stripe, catalogKey: string): Promise<Stripe.Product> {
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata?.catalog_key === catalogKey) return product
  }
  throw new Error(`No active product with catalog_key=${catalogKey} — run scripts/stripe-catalog.ts first.`)
}

// Everything that must NOT change across the swap, captured so the after-state
// can be compared field by field.
type Snapshot = {
  status: string
  customer: string
  created: number
  billingAnchor: number
  periodEnd: number
  cancelAtPeriodEnd: boolean
  defaultPaymentMethod: string | null
  discounts: string
  itemDiscounts: string
  latestInvoice: string | null
  amount: number | null
  currency: string
  interval: string
}

function snapshot(sub: Stripe.Subscription): Snapshot {
  const item = sub.items.data[0]
  return {
    status: sub.status,
    customer: idOf(sub.customer) ?? '',
    created: sub.created,
    billingAnchor: sub.billing_cycle_anchor,
    periodEnd: item.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    defaultPaymentMethod: idOf(sub.default_payment_method),
    discounts: (sub.discounts ?? []).map((d) => idOf(d)).join(',') || 'none',
    itemDiscounts: (item.discounts ?? []).map((d) => idOf(d)).join(',') || 'none',
    latestInvoice: idOf(sub.latest_invoice),
    amount: item.price.unit_amount,
    currency: item.price.currency,
    interval: `${item.price.recurring?.interval_count ?? '?'} ${item.price.recurring?.interval ?? 'one-time'}`,
  }
}

function printSnapshot(s: Snapshot): void {
  console.log(`      status ${s.status} · created ${date(s.created)} · ${money(s.amount, s.currency)} every ${s.interval}`)
  console.log(`      next bill ${date(s.periodEnd)} · cancel at period end: ${s.cancelAtPeriodEnd}`)
  console.log(`      payment method (sub-level): ${s.defaultPaymentMethod ?? 'none — falls back to the customer default'}`)
  console.log(`      discounts: ${s.discounts} · item discounts: ${s.itemDiscounts}`)
}

// Fields compared before vs after. Any difference is printed as a FAILURE.
function compare(before: Snapshot, after: Snapshot): string[] {
  const diffs: string[] = []
  for (const key of Object.keys(before) as (keyof Snapshot)[]) {
    if (before[key] !== after[key]) diffs.push(`${key}: ${before[key]} → ${after[key]}`)
  }
  return diffs
}

// A subscription to consider, with the customer email it bills (for display and
// --bundle / --exclude matching).
type Target = { sub: Stripe.Subscription; email: string | null }

function emailOf(customer: Stripe.Subscription['customer']): string | null {
  if (typeof customer === 'string' || ('deleted' in customer && customer.deleted)) return null
  return (customer as Stripe.Customer).email?.toLowerCase() ?? null
}

async function targetsForEmail(stripe: Stripe, email: string): Promise<Target[]> {
  const targets: Target[] = []
  for await (const customer of stripe.customers.list({ email, limit: 100 })) {
    for await (const sub of stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 100,
    })) {
      targets.push({ sub, email })
    }
  }
  return targets
}

// Every subscription billing any price of a legacy product. Subscriptions can
// be filtered by price but not by product, so this walks the product's prices
// (archived ones included — an old subscription can sit on an archived price).
async function targetsForProduct(stripe: Stripe, productId: string): Promise<Target[]> {
  const targets: Target[] = []
  for await (const price of stripe.prices.list({ product: productId, limit: 100 })) {
    if (price.type !== 'recurring') continue // one-time prices bill no subscription
    for await (const sub of stripe.subscriptions.list({
      price: price.id,
      status: 'all',
      limit: 100,
      expand: ['data.customer'],
    })) {
      targets.push({ sub, email: emailOf(sub.customer) })
    }
  }
  return targets
}

// Bulk revert: every subscription this script migrated off the given product.
// Search lags writes by up to a minute, which is fine for an undo.
async function migratedFromProduct(stripe: Stripe, productId: string): Promise<Target[]> {
  const targets: Target[] = []
  for await (const sub of stripe.subscriptions.search({
    query: `metadata['${FROM_PRODUCT}']:'${productId}'`,
    limit: 100,
    expand: ['data.customer'],
  })) {
    targets.push({ sub, email: emailOf(sub.customer) })
  }
  return targets
}

// No target given: list every non-catalog product with how many live
// subscriptions it bills, so the operator can pick the --product ids.
async function printInventory(stripe: Stripe): Promise<void> {
  console.log('\nNon-catalog products and their active / trialing / past_due subscriptions:')
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata?.catalog_key) continue
    let live = 0
    for (const { sub } of await targetsForProduct(stripe, product.id)) {
      if (MIGRATABLE_STATUSES.has(sub.status)) live++
    }
    if (!product.active && live === 0) continue // archived and empty: noise
    console.log(`  ${product.id}  ${String(live).padStart(5)}  "${product.name}"${product.active ? '' : ' (archived)'}`)
  }
  console.log('\nPass --product=<id> (repeatable) for the ICMB products to migrate.')
}

// The product behind a subscription's (single) item. Stripe caps expansion at
// four levels, so `items.data.price.product` can't be expanded off a list or
// retrieve — fetched on its own instead, and cached across a bulk run.
const productCache = new Map<string, Stripe.Product | null>()
async function productOf(stripe: Stripe, sub: Stripe.Subscription): Promise<Stripe.Product | null> {
  const ref = sub.items.data[0]?.price.product
  if (!ref) return null
  const id = typeof ref === 'string' ? ref : ref.id
  if (!productCache.has(id)) {
    const product = typeof ref === 'string' ? await stripe.products.retrieve(ref) : ref
    productCache.set(id, 'deleted' in product && product.deleted ? null : (product as Stripe.Product))
  }
  return productCache.get(id) ?? null
}

// Why a subscription can't be migrated, or null when it can.
function blockerFor(
  sub: Stripe.Subscription,
  product: Stripe.Product | null,
  revert: boolean,
  target: Stripe.Product,
): string | null {
  if (!MIGRATABLE_STATUSES.has(sub.status)) return `status is ${sub.status}`
  if (sub.items.data.length !== 1) return `${sub.items.data.length} items (expected exactly 1)`
  if (sub.schedule) return 'has a subscription schedule attached — release it first'
  if (sub.pending_update) return 'has a pending update'
  const price = sub.items.data[0].price
  if (revert) {
    if (!sub.metadata?.[FROM_PRICE]) return 'not migrated by this script (no icmb_from_price marker)'
    return null
  }
  if (!product) return 'product is deleted or missing'
  const key = product.metadata?.catalog_key
  if (key && key === target.metadata?.catalog_key) return `already on ${target.name}`
  // A staffer this script already moved to Ark+ may move on to the Bundle.
  const reTarget =
    key === 'ark_plus' && target.metadata?.catalog_key === 'bundle' && !!sub.metadata?.[FROM_PRICE]
  if (key && !reTarget) return `already on catalog product "${product.name}"`
  if (price.unit_amount == null) return 'price has no fixed unit_amount (tiered/metered)'
  if (!planOf(price)) return `interval is ${price.recurring?.interval_count} ${price.recurring?.interval}, not monthly/yearly`
  return null
}

async function migrate(
  stripe: Stripe,
  sub: Stripe.Subscription,
  product: Stripe.Product | null,
  target: Stripe.Product,
): Promise<void> {
  const item = sub.items.data[0]
  const price = item.price
  const taxBehavior = price.tax_behavior
  await stripe.subscriptions.update(sub.id, {
    items: [
      {
        id: item.id,
        price_data: {
          product: target.id,
          currency: price.currency,
          unit_amount: price.unit_amount!,
          recurring: {
            interval: price.recurring!.interval,
            interval_count: price.recurring!.interval_count,
          },
          ...(taxBehavior && taxBehavior !== 'unspecified' ? { tax_behavior: taxBehavior } : {}),
        },
      },
    ],
    proration_behavior: 'none',
    metadata: {
      plan: planOf(price)!,
      [MIGRATED_AT]: new Date().toISOString(),
      // A re-target (Ark+ → Bundle) keeps the ORIGINAL legacy price as the
      // revert point, not the Ark+ price it is leaving.
      [FROM_PRICE]: sub.metadata?.[FROM_PRICE] || price.id,
      [FROM_PRODUCT]: sub.metadata?.[FROM_PRODUCT] || (idOf(product) ?? ''),
    },
  })
}

async function revertMigration(stripe: Stripe, sub: Stripe.Subscription): Promise<void> {
  await stripe.subscriptions.update(sub.id, {
    items: [{ id: sub.items.data[0].id, price: sub.metadata[FROM_PRICE] }],
    proration_behavior: 'none',
    // '' deletes a metadata key. `plan` is left: it is accurate either way.
    metadata: { [MIGRATED_AT]: '', [FROM_PRICE]: '', [FROM_PRODUCT]: '' },
  })
}

// --- Main ------------------------------------------------------------------

function listArg(args: string[], name: string): string[] {
  return args
    .filter((a) => a.startsWith(`--${name}=`))
    .map((a) => a.slice(name.length + 3).trim())
    .filter(Boolean)
}

// --<name>=<addr> (repeatable) plus --<name>-file=<path>, lower-cased.
async function emailSet(args: string[], name: string): Promise<Set<string>> {
  const set = new Set(listArg(args, name).map((e) => e.toLowerCase()))
  for (const file of listArg(args, `${name}-file`)) {
    for (const line of (await Bun.file(file).text()).split('\n')) {
      const email = line.trim().toLowerCase()
      if (email && !email.startsWith('#')) set.add(email)
    }
  }
  return set
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const live = args.includes('--live')
  const revert = args.includes('--revert')
  const emails = listArg(args, 'email').map((e) => e.toLowerCase())
  const products = listArg(args, 'product')
  const excluded = await emailSet(args, 'exclude')
  const bundled = await emailSet(args, 'bundle')
  const both = [...bundled].filter((e) => excluded.has(e))
  if (both.length > 0) {
    console.error(`Both --bundle and --exclude given for: ${both.join(', ')}`)
    process.exit(1)
  }
  const limitArg = listArg(args, 'limit')[0]
  const limit = limitArg ? Number.parseInt(limitArg, 10) : Infinity
  if (Number.isNaN(limit) || limit < 1) {
    console.error('--limit must be a positive integer.')
    process.exit(1)
  }
  if (emails.length > 0 && products.length > 0) {
    console.error('Pass --email or --product, not both.')
    process.exit(1)
  }

  const key = process.env.STRIPE_SECRET_KEY
  assertKeyMode(key, live)
  const stripe = new Stripe(key)

  const mode = live ? 'LIVE' : 'TEST'
  if (emails.length === 0 && products.length === 0) {
    console.log(`=== INVENTORY (${mode}, no writes) ===`)
    await printInventory(stripe)
    return
  }
  if (live && apply) await assertLiveAccount(stripe)

  const action = revert ? 'REVERT' : 'MIGRATE'
  console.log(apply ? `=== ${action} — APPLY (writing to Stripe ${mode}) ===` : `=== ${action} — PREVIEW (${mode}, no writes) ===`)

  const arkPlus = await findCatalogProduct(stripe, 'ark_plus')
  const bundle = await findCatalogProduct(stripe, 'bundle')
  console.log(`Ark+ product: ${arkPlus.id} "${arkPlus.name}"`)
  console.log(`Bundle product: ${bundle.id} "${bundle.name}"`)
  if (bundled.size > 0) console.log(`Moving ${bundled.size} email(s) to the Bundle.`)
  if (excluded.size > 0) console.log(`Excluding ${excluded.size} email(s).`)
  if (limit !== Infinity) console.log(`Limit: ${limit} subscription(s) this run.`)

  // Collect the targets, de-duplicated by subscription id.
  const targets = new Map<string, Target>()
  for (const email of emails) {
    const found = await targetsForEmail(stripe, email)
    if (found.length === 0) console.log(`\n${email}: no Stripe customer / subscriptions`)
    for (const t of found) targets.set(t.sub.id, t)
  }
  for (const productId of products) {
    const product = await stripe.products.retrieve(productId)
    if (product.metadata?.catalog_key) {
      console.error(`Refusing --product=${productId}: "${product.name}" is a catalog product.`)
      process.exit(1)
    }
    console.log(`Source product: ${product.id} "${product.name}"`)
    const found = revert
      ? await migratedFromProduct(stripe, productId)
      : await targetsForProduct(stripe, productId)
    for (const t of found) targets.set(t.sub.id, t)
  }

  const counts = { done: 0, would: 0, toBundle: 0, excluded: 0, skipped: 0, failed: 0 }
  const unseenBundled = new Set(bundled)
  const skipReasons = new Map<string, number>()
  for (const { sub, email } of targets.values()) {
    if (counts.done + counts.would >= limit) break

    // Ended subscriptions are the bulk of a product's history; keep them out of
    // the per-subscription log and just count them.
    if (!MIGRATABLE_STATUSES.has(sub.status)) {
      counts.skipped++
      skipReasons.set(`status ${sub.status}`, (skipReasons.get(`status ${sub.status}`) ?? 0) + 1)
      continue
    }

    const price = sub.items.data[0]?.price
    const product = await productOf(stripe, sub)
    console.log(`\n${email ?? '(no email)'}`)
    console.log(`  ${sub.id} on "${product?.name ?? '?'}" (${idOf(product)}, price ${price?.id})`)
    const before = snapshot(sub)
    printSnapshot(before)

    if (email) unseenBundled.delete(email)
    if (email && excluded.has(email)) {
      counts.excluded++
      console.log('    EXCLUDED')
      continue
    }
    const target = email && bundled.has(email) ? bundle : arkPlus
    const blocker = blockerFor(sub, product, revert, target)
    if (blocker) {
      counts.skipped++
      skipReasons.set(blocker, (skipReasons.get(blocker) ?? 0) + 1)
      console.log(`    SKIP: ${blocker}`)
      continue
    }

    console.log(
      revert
        ? `    WILL restore price ${sub.metadata[FROM_PRICE]} (no proration) and clear the migration markers`
        : `    WILL move to "${target.name}" at ${money(price.unit_amount, price.currency)} ${planOf(price)} ` +
            '(own amount kept, no proration, no invoice), and stamp plan + migration markers',
    )
    if (!revert && target === bundle) counts.toBundle++
    if (!apply) {
      counts.would++
      continue
    }

    // One failure must not stop a bulk run; it is counted and reported.
    try {
      if (revert) await revertMigration(stripe, sub)
      else await migrate(stripe, sub, product, target)

      // Re-read and prove nothing the member cares about moved.
      const updated = await stripe.subscriptions.retrieve(sub.id)
      const after = snapshot(updated)
      const newProduct = await productOf(stripe, updated)
      console.log(`    DONE → now on "${newProduct?.name ?? '?'}" (price ${updated.items.data[0].price.id})`)
      printSnapshot(after)
      const diffs = compare(before, after)
      if (diffs.length > 0) {
        counts.failed++
        console.error(`    FAILURE — these changed:\n      ${diffs.join('\n      ')}`)
      } else {
        counts.done++
        console.log('    VERIFIED: status, created, billing anchor, next bill, amount, currency, interval, payment method, discounts and latest invoice all unchanged')
      }
    } catch (err) {
      counts.failed++
      console.error(`    FAILURE: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log('\n=== Summary ===')
  if (apply) console.log(`  ${revert ? 'reverted' : 'migrated'} + verified: ${counts.done}`)
  else console.log(`  would ${revert ? 'revert' : 'migrate'}: ${counts.would}`)
  if (!revert) console.log(`    of which to the Bundle: ${counts.toBundle}`)
  console.log(`  excluded: ${counts.excluded}`)
  console.log(`  skipped: ${counts.skipped}`)
  for (const [reason, n] of skipReasons) console.log(`    ${String(n).padStart(5)}  ${reason}`)
  console.log(`  failed: ${counts.failed}`)
  // A --bundle email that matched nothing is most likely a typo — and a typo'd
  // staffer is migrated to Ark+ under their real address.
  if (unseenBundled.size > 0) {
    console.warn(`\n  WARNING: --bundle email(s) with no subscription in this run: ${[...unseenBundled].join(', ')}`)
  }
  console.log(apply ? '\nDone.' : '\nPreview only — nothing was written. Re-run with --apply to write.')
  if (counts.failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[migrate-icmb] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
