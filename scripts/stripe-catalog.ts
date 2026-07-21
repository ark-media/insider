// Stripe catalog provisioning — the three persistent products and six
// lookup-key prices the entitlement redesign sells (tasks/entitlement-tiers.md
// §4, task 1). Run this once to create the catalog, and re-run any time to
// refresh amounts (FX drift) — it is idempotent.
//
// TEST MODE ONLY. Live mode is out of scope for this whole redesign (§1b). The
// script hard-refuses to run against a live key: it requires STRIPE_SECRET_KEY
// (Bun auto-loads .env) to start with `sk_test_` and aborts otherwise.
//
// Idempotency:
//   - Products are addressed by a stable `metadata.catalog_key` (ark_plus /
//     circle / bundle), resolved via `products.list` (strongly consistent) —
//     never re-created. Product Search is deliberately avoided: it lags
//     creation by up to a minute, so a re-run inside that window would not
//     find a just-created product and would mint a duplicate. See scanProducts.
//   - Prices are addressed by `lookup_key`. Prices are immutable in Stripe, so
//     an amount change can't edit in place: we create a NEW price carrying the
//     same lookup_key with `transfer_lookup_key: true` (Stripe moves the key
//     off the old price) and archive the old one. Unchanged prices are left be.
//
// Usage:
//   bun run scripts/stripe-catalog.ts                     # preview (no writes)
//   bun run scripts/stripe-catalog.ts --apply             # create / refresh catalog
//   bun run scripts/stripe-catalog.ts --apply --archive-orphans
//                                                         # also archive sandbox
//                                                         # orphans (run only AFTER
//                                                         # checkout is on the new
//                                                         # catalog — task 8)

import Stripe from 'stripe'

// --- Catalog definition ----------------------------------------------------

// Pay-what-you-choose floors, in minor units (cents / pence). USD is each
// price's base currency; gbp/eur/cad ride along as `currency_options` so
// checkout can present a localized floor per §7 #4. Enabling currency_options
// disables Stripe Adaptive Pricing — disable Adaptive in the Dashboard once the
// new checkout (task 8) is live.
//
// Default is same-numeral localization (US$8 / £8 / €8 / C$8): clean round
// floors, no FX noise. Edit these and re-run --apply to change or FX-refresh.
const CURRENCIES = ['usd', 'gbp', 'eur', 'cad'] as const
type Currency = (typeof CURRENCIES)[number]
type Amounts = Record<Currency, number>

// Suggested = the floor (PWYC lets buyers pay more, never less). §5: Founding
// Member is cut for launch, but `founding_multiple` metadata stays on the
// products (inert without any reading logic) so a later revival is config-only.
const FOUNDING_MULTIPLE = '2'

type PriceDef = {
  lookup_key: string
  interval: 'month' | 'year'
  amounts: Amounts
}

type ProductDef = {
  catalogKey: string
  name: string
  description: string
  entitlements: string // comma-separated: what buying this grants
  scPlan: boolean // does this product provision a Supporting Cast feed?
  prices: PriceDef[]
}

const CATALOG: ProductDef[] = [
  {
    catalogKey: 'ark_plus',
    name: 'Ark+',
    description: 'Private ad-free podcast feed (Supporting Cast).',
    entitlements: 'ark_plus',
    scPlan: true,
    prices: [
      { lookup_key: 'ark_plus_monthly', interval: 'month', amounts: { usd: 800, gbp: 800, eur: 800, cad: 800 } },
      { lookup_key: 'ark_plus_yearly', interval: 'year', amounts: { usd: 8000, gbp: 8000, eur: 8000, cad: 8000 } },
    ],
  },
  {
    catalogKey: 'circle',
    name: 'Ark Community',
    description: 'Access to the Ark community (Circle).',
    entitlements: 'circle',
    scPlan: false,
    prices: [
      { lookup_key: 'circle_monthly', interval: 'month', amounts: { usd: 800, gbp: 800, eur: 800, cad: 800 } },
      { lookup_key: 'circle_yearly', interval: 'year', amounts: { usd: 8000, gbp: 8000, eur: 8000, cad: 8000 } },
    ],
  },
  {
    catalogKey: 'bundle',
    name: 'Ark+ & Community',
    description: 'Private ad-free feed and community access.',
    entitlements: 'ark_plus,circle',
    scPlan: true,
    prices: [
      { lookup_key: 'bundle_monthly', interval: 'month', amounts: { usd: 1300, gbp: 1300, eur: 1300, cad: 1300 } },
      { lookup_key: 'bundle_yearly', interval: 'year', amounts: { usd: 13000, gbp: 13000, eur: 13000, cad: 13000 } },
    ],
  },
]

// --- Guards ----------------------------------------------------------------

function assertTestMode(key: string | undefined): asserts key is string {
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set. Add your TEST key (sk_test_…) to .env.')
    process.exit(1)
  }
  if (!key.startsWith('sk_test_')) {
    console.error(
      'Refusing to run: STRIPE_SECRET_KEY is not a test key (must start with "sk_test_").\n' +
        'This redesign is test-mode only (§1b). Live mode is out of scope.',
    )
    process.exit(1)
  }
}

// --- Helpers ---------------------------------------------------------------

function currencyOptions(amounts: Amounts): Record<string, { unit_amount: number }> {
  const opts: Record<string, { unit_amount: number }> = {}
  for (const cur of CURRENCIES) {
    if (cur === 'usd') continue // usd is the base currency, not an option
    opts[cur] = { unit_amount: amounts[cur] }
  }
  return opts
}

function amountsMatch(price: Stripe.Price, amounts: Amounts): boolean {
  if (price.unit_amount !== amounts.usd) return false
  const opts = price.currency_options ?? {}
  for (const cur of CURRENCIES) {
    if (cur === 'usd') continue
    if (opts[cur]?.unit_amount !== amounts[cur]) return false
  }
  return true
}

function fmt(amounts: Amounts): string {
  return CURRENCIES.map((c) => `${c} ${(amounts[c] / 100).toFixed(2)}`).join(' · ')
}

// Scan every active product ONCE into a map keyed by catalog_key. Uses
// products.list (strongly consistent) rather than Product Search — Search lags
// creation by up to a minute, which would make the script non-idempotent and
// mint duplicate products on a re-run inside that window. Products without a
// catalog_key are returned separately as orphans.
async function scanProducts(
  stripe: Stripe,
): Promise<{ byCatalogKey: Map<string, Stripe.Product>; orphans: Stripe.Product[] }> {
  const byCatalogKey = new Map<string, Stripe.Product>()
  const orphans: Stripe.Product[] = []
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    const key = product.metadata?.catalog_key
    if (key) byCatalogKey.set(key, product)
    else orphans.push(product)
  }
  return { byCatalogKey, orphans }
}

async function upsertProduct(
  stripe: Stripe,
  def: ProductDef,
  existing: Stripe.Product | undefined,
  apply: boolean,
): Promise<string | null> {
  const metadata: Record<string, string> = {
    catalog_key: def.catalogKey,
    entitlements: def.entitlements,
    founding_multiple: FOUNDING_MULTIPLE,
  }
  if (def.scPlan) metadata.sc_subscription_plan_id = 'true'

  if (existing) {
    console.log(`  product ${def.catalogKey}: exists (${existing.id}) — updating name/metadata`)
    if (apply) {
      await stripe.products.update(existing.id, {
        name: def.name,
        description: def.description,
        metadata,
      })
    }
    return existing.id
  }
  console.log(`  product ${def.catalogKey}: CREATE "${def.name}"`)
  if (!apply) return null
  const created = await stripe.products.create({
    name: def.name,
    description: def.description,
    metadata,
  })
  return created.id
}

async function upsertPrice(
  stripe: Stripe,
  productId: string | null,
  def: PriceDef,
  apply: boolean,
): Promise<void> {
  const list = await stripe.prices.list({
    lookup_keys: [def.lookup_key],
    active: true,
    limit: 1,
    expand: ['data.currency_options'],
  })
  const existing = list.data[0]

  if (existing && amountsMatch(existing, def.amounts) && existing.product === productId) {
    console.log(`    price ${def.lookup_key}: unchanged (${existing.id})`)
    return
  }

  if (existing) {
    console.log(
      `    price ${def.lookup_key}: REFRESH — new price (${fmt(def.amounts)}), ` +
        `transfer lookup_key off ${existing.id} and archive it`,
    )
  } else {
    console.log(`    price ${def.lookup_key}: CREATE (${fmt(def.amounts)})`)
  }
  if (!apply) return
  if (!productId) throw new Error(`No product id for ${def.lookup_key} (create products first)`)

  await stripe.prices.create({
    product: productId,
    currency: 'usd',
    unit_amount: def.amounts.usd,
    recurring: { interval: def.interval },
    lookup_key: def.lookup_key,
    transfer_lookup_key: true, // moves the key off the old price if one holds it
    currency_options: currencyOptions(def.amounts),
  })
  if (existing) {
    await stripe.prices.update(existing.id, { active: false })
  }
}

// Sandbox orphans — products created by the old `product_data`-per-checkout
// pattern (the source of the sprawl, §4). Anything active without our
// `catalog_key` marker. Report by default; archive only with --archive-orphans,
// and only run that AFTER checkout is on the new catalog (task 8) so we don't
// archive the product the live test checkout still points at.
async function handleOrphans(
  stripe: Stripe,
  orphans: Stripe.Product[],
  archive: boolean,
  apply: boolean,
): Promise<void> {
  if (orphans.length === 0) {
    console.log('  no orphan products.')
    return
  }
  console.log(`  ${orphans.length} orphan product(s) (not part of the catalog):`)
  for (const p of orphans) console.log(`    ${p.id}  "${p.name}"`)
  if (!archive) {
    console.log('  (re-run with --archive-orphans to archive these — do this only after task 8)')
    return
  }
  for (const p of orphans) {
    console.log(`    archiving ${p.id}…`)
    if (apply) await stripe.products.update(p.id, { active: false })
  }
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const archiveOrphans = args.includes('--archive-orphans')

  const key = process.env.STRIPE_SECRET_KEY
  assertTestMode(key)
  const stripe = new Stripe(key)

  console.log(apply ? '=== APPLY (writing to Stripe TEST mode) ===' : '=== PREVIEW (no writes) ===')

  const { byCatalogKey, orphans } = await scanProducts(stripe)

  for (const def of CATALOG) {
    console.log(`\n${def.name} [${def.entitlements}]`)
    const productId = await upsertProduct(stripe, def, byCatalogKey.get(def.catalogKey), apply)
    for (const price of def.prices) {
      await upsertPrice(stripe, productId, price, apply)
    }
  }

  console.log('\nOrphans:')
  await handleOrphans(stripe, orphans, archiveOrphans, apply)

  console.log(
    apply
      ? '\nDone. Catalog is provisioned. Verify prices by lookup_key in the Dashboard (test mode).'
      : '\nPreview only — nothing was written. Re-run with --apply to provision.',
  )
}

main().catch((err) => {
  console.error('[stripe-catalog] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
