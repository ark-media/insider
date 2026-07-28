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

// Localized pay-what-you-choose floors, in minor units. USD is each price's base
// currency; the rest ride along as `currency_options` so checkout can present a
// localized floor per §7 #4. Enabling currency_options disables Stripe Adaptive
// Pricing — disable Adaptive in the Dashboard once the new checkout (task 8) is
// live. Keep this list in sync with server/lib/pricing.ts SUPPORTED_CURRENCIES.
const CURRENCIES = [
  'usd', 'gbp', 'eur', 'cad', 'czk', 'dkk', 'huf', 'nok', 'pln', 'ron',
  'rub', 'sek', 'chf', 'aud', 'hkd', 'idr', 'jpy', 'kzt', 'krw', 'myr',
  'nzd', 'php', 'sgd', 'twd', 'thb', 'vnd', 'egp', 'inr', 'ils', 'ngn',
  'qar', 'sar', 'zar', 'tzs', 'aed', 'brl', 'clp', 'cop', 'mxn', 'pen',
] as const
type Currency = (typeof CURRENCIES)[number]
type Amounts = Record<Currency, number>

// Zero-decimal currencies — the amount IS the whole-unit figure (¥1300 = 1300),
// never ×100. Mirrors server/lib/pricing.ts ZERO_DECIMAL_CURRENCIES (kept local
// so this provisioning script stays standalone). Used only by the preview log —
// BASE_MONTHLY_MINOR below is already encoded correctly per currency.
const ZERO_DECIMAL = new Set<Currency>(['jpy', 'krw', 'vnd', 'clp'])

// Column 1 of the localized price table (Stripe purchasing-power presets) for
// the $8/mo Ark+ · Circle base, in MINOR units — 2-decimal currencies ×100 of
// the table figure, zero-decimal currencies the whole figure. This is the ONE
// place amounts are edited; Bundle scales off it (×13/8) and yearly is ×10.
const BASE_MONTHLY_MINOR: Amounts = {
  usd: 800, gbp: 800, eur: 900, cad: 1000, czk: 19900,
  dkk: 6900, huf: 349000, nok: 9900, pln: 3999, ron: 3999,
  rub: 69900, sek: 9900, chf: 700, aud: 1200, hkd: 5800,
  idr: 12900000, jpy: 1300, kzt: 499000, krw: 12000, myr: 3990,
  nzd: 1500, php: 49900, sgd: 998, twd: 29000, thb: 29900,
  vnd: 249000, egp: 39999, inr: 79900, ils: 2990, ngn: 1290000,
  qar: 2999, sar: 3499, zar: 14999, tzs: 2290000, aed: 2999,
  brl: 4990, clp: 9990, cop: 3990000, mxn: 17900, pen: 3490,
}

// Suggested = the floor (PWYC lets buyers pay more, never less). §5: Founding
// Member is cut for launch, but `founding_multiple` metadata stays on the
// products (inert without any reading logic) so a later revival is config-only.
const FOUNDING_MULTIPLE = '2'

// Every currency's amount for a tier+plan, derived from the base table:
//   monthly = base × (usdMonthlyMinor / base.usd)  — 1× for the $8 tiers, 13/8
//                                                     for Bundle ($13)
//   yearly  = monthly × 10                          — matches the USD 10:1 ratio
// Rounded to an integer minor-unit amount (valid for every currency). Bundle's
// non-USD rows are mechanically derived, not hand-tuned charm prices — swap in a
// dedicated Bundle table here if that changes.
function amountsFor(usdMonthlyMinor: number, interval: 'month' | 'year'): Amounts {
  const monthScale = usdMonthlyMinor / BASE_MONTHLY_MINOR.usd
  const yearFactor = interval === 'year' ? 10 : 1
  const out = {} as Amounts
  for (const cur of CURRENCIES) {
    out[cur] = Math.round(BASE_MONTHLY_MINOR[cur] * monthScale * yearFactor)
  }
  return out
}

type PriceDef = {
  lookup_key: string
  // 'month' | 'year' for recurring subscription prices; undefined for one-time
  // gift prices (mode: 'payment'). A recurring price can't be used in a
  // payment-mode Checkout Session, so gifts need their own non-recurring prices.
  interval: 'month' | 'year' | undefined
  amounts: Amounts
}

type ProductDef = {
  catalogKey: string
  name: string
  description: string
  entitlements: string // comma-separated: what buying this grants
  scPlan: boolean // does this product provision a Supporting Cast feed?
  usdMonthlyMinor: number // $8-base anchor; other currencies scale from BASE_MONTHLY_MINOR
}

// The monthly + yearly price for a product, generated from its USD anchor.
function pricesFor(def: ProductDef): PriceDef[] {
  return [
    { lookup_key: `${def.catalogKey}_monthly`, interval: 'month', amounts: amountsFor(def.usdMonthlyMinor, 'month') },
    { lookup_key: `${def.catalogKey}_yearly`, interval: 'year', amounts: amountsFor(def.usdMonthlyMinor, 'year') },
  ]
}

const CATALOG: ProductDef[] = [
  {
    catalogKey: 'ark_plus',
    name: 'Ark+',
    description: 'Private ad-free podcast feed (Supporting Cast).',
    entitlements: 'ark_plus',
    scPlan: true,
    usdMonthlyMinor: 800,
  },
  {
    catalogKey: 'circle',
    name: 'Ark Community',
    description: 'Access to the Ark community (Circle).',
    entitlements: 'circle',
    scPlan: false,
    usdMonthlyMinor: 800,
  },
  {
    catalogKey: 'bundle',
    name: 'Ark+ & Community',
    description: 'Private ad-free feed and community access.',
    entitlements: 'ark_plus,circle',
    scPlan: true,
    usdMonthlyMinor: 1300,
  },
]

// --- Gift catalog ----------------------------------------------------------

// Gifts are one-time purchases, priced INDEPENDENTLY of the subscription tiers
// (tasks/prd-gift-tiers.md D1). USD anchors are hand-set charm prices; the other
// 39 currencies scale the axis's localized monthly base by (giftUsd /
// tierMonthlyUsd), so a localized gift floor tracks localized subscription
// pricing without being derived from a subscription Price object at runtime.
//   | Tier      | 6mo | 1yr  |
//   | Ark+      | $48 | $80  |
//   | Community | $48 | $80  |
//   | Bundle    | $75 | $130 |
type GiftTerm = '6mo' | '1yr'
const GIFT_TERMS = ['6mo', '1yr'] as const

type GiftProductDef = {
  catalogKey: string // gift_ark_plus | gift_circle | gift_bundle
  name: string
  description: string
  entitlements: string // ark_plus | circle | ark_plus,circle
  tierMonthlyUsdMinor: number // the axis's monthly USD base, to localize non-USD amounts
  anchors: Record<GiftTerm, number> // USD minor-unit anchors per term
}

// Per-currency amounts for a gift term: USD is the exact charm anchor; the rest
// scale the axis's localized monthly base by (anchor / tierMonthly).
function giftAmountsFor(tierMonthlyUsdMinor: number, usdAnchorMinor: number): Amounts {
  const monthly = amountsFor(tierMonthlyUsdMinor, 'month')
  const scale = usdAnchorMinor / tierMonthlyUsdMinor
  const out = {} as Amounts
  for (const cur of CURRENCIES) out[cur] = Math.round(monthly[cur] * scale)
  out.usd = usdAnchorMinor // exact anchor, never a rounded scale
  return out
}

// One-time (recurring: undefined) prices for a gift product, lookup-keyed
// gift_<tier>_<term>.
function giftPricesFor(def: GiftProductDef): PriceDef[] {
  return GIFT_TERMS.map((term) => ({
    lookup_key: `${def.catalogKey}_${term}`,
    interval: undefined,
    amounts: giftAmountsFor(def.tierMonthlyUsdMinor, def.anchors[term]),
  }))
}

const GIFT_CATALOG: GiftProductDef[] = [
  {
    catalogKey: 'gift_ark_plus',
    name: 'Ark+ Gift',
    description: 'Gift a private ad-free podcast feed (Supporting Cast).',
    entitlements: 'ark_plus',
    tierMonthlyUsdMinor: 800,
    anchors: { '6mo': 4800, '1yr': 8000 },
  },
  {
    catalogKey: 'gift_circle',
    name: 'Ark Community Gift',
    description: 'Gift access to the Ark community (Circle).',
    entitlements: 'circle',
    tierMonthlyUsdMinor: 800,
    anchors: { '6mo': 4800, '1yr': 8000 },
  },
  {
    catalogKey: 'gift_bundle',
    name: 'Ark+ & Community Gift',
    description: 'Gift the private ad-free feed and community access.',
    entitlements: 'ark_plus,circle',
    tierMonthlyUsdMinor: 1300,
    anchors: { '6mo': 7500, '1yr': 13000 },
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
  return CURRENCIES.map((c) => {
    const zero = ZERO_DECIMAL.has(c)
    return `${c} ${(amounts[c] / (zero ? 1 : 100)).toFixed(zero ? 0 : 2)}`
  }).join(' · ')
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
    // Recurring for subscription prices; omitted → one-time for gift prices.
    ...(def.interval ? { recurring: { interval: def.interval } } : {}),
    lookup_key: def.lookup_key,
    transfer_lookup_key: true, // moves the key off the old price if one holds it
    currency_options: currencyOptions(def.amounts),
  })
  if (existing) {
    await stripe.prices.update(existing.id, { active: false })
  }
}

// Gift products carry kind:'gift' and no founding/SC metadata (SC gift feeds are
// provisioned via SC_SUBSCRIPTION_PRICE_ID_GIFT_* env, not this Stripe product).
async function upsertGiftProduct(
  stripe: Stripe,
  def: GiftProductDef,
  existing: Stripe.Product | undefined,
  apply: boolean,
): Promise<string | null> {
  const metadata: Record<string, string> = {
    catalog_key: def.catalogKey,
    entitlements: def.entitlements,
    kind: 'gift',
  }
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

// --- Debundle intro coupon -------------------------------------------------

// How long the intro rate runs after a bundle is split. Six monthly invoices —
// or, on an annual plan, the one annual invoice that falls inside the window,
// i.e. a full discounted year. Both are intended; see debundlePricePreview.
const DEBUNDLE_INTRO_MONTHS = 6

// The bounded rate a debundling member lands on: the per-component price they
// already paid inside the bundle (half of it), expressed as a percentage off the
// standalone price they're moving to. Derived from the catalog rather than
// hardcoded, so it stays correct if Ryan retunes either number — and it's the
// same percentage for both cadences, since the yearly prices scale together.
//
//   $8.00 standalone → 18.75% off → $6.50   (half of the $13 bundle)
//   $80.00 standalone → 18.75% off → $65.00 (half of the $130 bundle)
//
// Rounded to Stripe's 2-decimal limit on percent_off.
function introPercentOff(): number {
  const single = CATALOG.find((d) => d.catalogKey === 'ark_plus')!.usdMonthlyMinor
  const bundle = CATALOG.find((d) => d.catalogKey === 'bundle')!.usdMonthlyMinor
  return Math.round((1 - bundle / 2 / single) * 10_000) / 100
}

// A coupon's discount is immutable in Stripe, so the id carries the percent: a
// retuned catalog mints a new coupon rather than silently leaving a stale rate
// attached to the slot. The server picks whichever is active, and derives the
// price it quotes by applying that coupon — so the quote can never drift from
// what gets charged.
function introCouponId(percentOff: number): string {
  return `debundle_intro_${String(percentOff).replace('.', '_')}_${DEBUNDLE_INTRO_MONTHS}mo`
}

// Provision the debundle intro coupon, tagged for the `debundle_intro` save slot
// so server/lib/retention.ts finds it. Idempotent: a coupon with this id already
// existing means the rate is unchanged.
async function upsertIntroCoupon(stripe: Stripe, apply: boolean): Promise<void> {
  const percentOff = introPercentOff()
  const id = introCouponId(percentOff)

  const existing = await stripe.coupons.retrieve(id).catch(() => null)
  if (existing) {
    console.log(`  coupon ${id}: unchanged (${percentOff}% off, ${DEBUNDLE_INTRO_MONTHS}mo)`)
    return
  }

  console.log(`  coupon ${id}: CREATE (${percentOff}% off for ${DEBUNDLE_INTRO_MONTHS} months)`)
  if (!apply) return
  await stripe.coupons.create({
    id,
    name: 'Debundle intro rate',
    percent_off: percentOff,
    duration: 'repeating',
    duration_in_months: DEBUNDLE_INTRO_MONTHS,
    metadata: { retention_offer: 'true', offer_kind: 'debundle_intro' },
  })
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
    for (const price of pricesFor(def)) {
      await upsertPrice(stripe, productId, price, apply)
    }
  }

  console.log('\n--- Gifts (one-time) ---')
  for (const def of GIFT_CATALOG) {
    console.log(`\n${def.name} [${def.entitlements}]`)
    const productId = await upsertGiftProduct(stripe, def, byCatalogKey.get(def.catalogKey), apply)
    for (const price of giftPricesFor(def)) {
      await upsertPrice(stripe, productId, price, apply)
    }
  }

  console.log('\n--- Debundle intro rate ---')
  await upsertIntroCoupon(stripe, apply)

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
