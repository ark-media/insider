// Stripe catalog provisioning — the three persistent products and six
// lookup-key prices the entitlement redesign sells (tasks/entitlement-tiers.md
// §4, task 1). Run this once to create the catalog, and re-run any time to
// refresh amounts (FX drift) — it is idempotent.
//
// Test mode by default. STRIPE_SECRET_KEY (Bun auto-loads .env) must start
// with `sk_test_` unless `--live` is passed, and a live run that WRITES
// (`--live --apply`) additionally needs CONFIRM_LIVE_ACCOUNT set to the live
// account's id (acct_…), which the script checks against the key before writing
// anything. `--archive-orphans` is refused in live mode: a live account can hold
// products that aren't ours to archive.
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
//   STRIPE_SECRET_KEY=sk_live_… bun run scripts/stripe-catalog.ts --live
//                                                         # preview against LIVE
//   STRIPE_SECRET_KEY=sk_live_… CONFIRM_LIVE_ACCOUNT=acct_… \
//     bun run scripts/stripe-catalog.ts --live --apply    # provision LIVE

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

// Charged in hundredths but only in whole units — an exact multiple of 100
// minor units (Stripe "special cases"). Mirrors server/lib/pricing.ts
// WHOLE_UNIT_CURRENCIES. The derived tiers (×19/8, ×25/8) land between whole
// forints and dollars without this, e.g. HUF 8,288.75.
const WHOLE_UNIT = new Set<Currency>(['huf', 'twd'])

// A derived amount rounded to something the currency can be charged in.
function roundFor(cur: Currency, amount: number): number {
  return WHOLE_UNIT.has(cur) ? Math.round(amount / 100) * 100 : Math.round(amount)
}

// Column 1 of the localized price table (Stripe purchasing-power presets) for
// the $8/mo Ark+ · Circle base, in MINOR units — 2-decimal currencies ×100 of
// the table figure, zero-decimal currencies the whole figure. This is the ONE
// place amounts are edited; each tier scales off it by its own USD anchor
// (Ark+ $8, the Fold $19, Bundle $25) and yearly is ×10.
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
//   monthly = base × (usdMonthlyMinor / base.usd)  — 1× for Ark+ ($8), 19/8 for
//                                                     the Fold, 25/8 for Bundle
//   yearly  = monthly × 10                          — matches the USD 10:1 ratio
// Rounded to an integer minor-unit amount (valid for every currency). Only Ark+
// sits on the hand-tuned charm-price table; the Fold and Bundle non-USD rows are
// mechanically derived — swap in dedicated tables here if that changes.
function amountsFor(usdMonthlyMinor: number, interval: 'month' | 'year'): Amounts {
  const monthScale = usdMonthlyMinor / BASE_MONTHLY_MINOR.usd
  const yearFactor = interval === 'year' ? 10 : 1
  const out = {} as Amounts
  for (const cur of CURRENCIES) {
    out[cur] = roundFor(cur, BASE_MONTHLY_MINOR[cur] * monthScale * yearFactor)
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
    description: 'Private ad-free podcast feed.',
    entitlements: 'ark_plus',
    usdMonthlyMinor: 800,
  },
  {
    catalogKey: 'circle',
    name: 'The Fold',
    description: 'Access to the Fold (Circle).',
    entitlements: 'circle',
    usdMonthlyMinor: 1900,
  },
  {
    catalogKey: 'bundle',
    name: 'Ark+ & The Fold',
    description: 'Private ad-free feed and access to the Fold.',
    entitlements: 'ark_plus,circle',
    usdMonthlyMinor: 2500,
  },
]

// --- Gift catalog ----------------------------------------------------------

// Gifts are one-time purchases priced off the subscription tier they grant, so
// a gift can't drift from what the same access costs as a subscription:
//   1yr = the tier's yearly price (monthly ×10, the same 10:1 anchor pricesFor
//         uses) — a gifted year costs exactly what a subscribed year costs
//   6mo = the tier's monthly price ×6 — six months at the plain monthly rate,
//         with no annual discount
//   | Tier      | 6mo  | 1yr  |
//   | Ark+      | $48  | $80  |
//   | The Fold  | $114 | $190 |
//   | Bundle    | $150 | $250 |
// Keep src/lib/gift.ts GIFT_PRICE_DOLLARS (the /plus/gift display copy) in sync.
type GiftTerm = '6mo' | '1yr'
const GIFT_TERMS = ['6mo', '1yr'] as const

// What each term costs as a multiple of the tier's MONTHLY price.
const GIFT_TERM_MULTIPLE: Record<GiftTerm, number> = { '6mo': 6, '1yr': 10 }

type GiftProductDef = {
  catalogKey: string // gift_ark_plus | gift_circle | gift_bundle
  name: string
  description: string
  entitlements: string // ark_plus | circle | ark_plus,circle
  tierCatalogKey: string // the CATALOG tier whose price this gift mirrors
}

// Per-currency amounts for a gift term: every currency is the tier's localized
// monthly base scaled by the term multiple, so a localized gift floor tracks
// localized subscription pricing across all 40 currencies. USD is computed
// exactly (never a rounded scale), which is what makes a 1yr gift land on the
// tier's yearly price to the cent.
function giftAmountsFor(tierMonthlyUsdMinor: number, multiple: number): Amounts {
  const monthScale = tierMonthlyUsdMinor / BASE_MONTHLY_MINOR.usd
  const out = {} as Amounts
  for (const cur of CURRENCIES) {
    out[cur] = roundFor(cur, BASE_MONTHLY_MINOR[cur] * monthScale * multiple)
  }
  out.usd = tierMonthlyUsdMinor * multiple
  return out
}

// One-time (recurring: undefined) prices for a gift product, lookup-keyed
// gift_<tier>_<term>.
function giftPricesFor(def: GiftProductDef): PriceDef[] {
  const tier = CATALOG.find((d) => d.catalogKey === def.tierCatalogKey)
  if (!tier) throw new Error(`${def.catalogKey}: no catalog tier "${def.tierCatalogKey}"`)
  return GIFT_TERMS.map((term) => ({
    lookup_key: `${def.catalogKey}_${term}`,
    interval: undefined,
    amounts: giftAmountsFor(tier.usdMonthlyMinor, GIFT_TERM_MULTIPLE[term]),
  }))
}

const GIFT_CATALOG: GiftProductDef[] = [
  {
    catalogKey: 'gift_ark_plus',
    name: 'Ark+ Gift',
    description: 'Gift a private ad-free podcast feed.',
    entitlements: 'ark_plus',
    tierCatalogKey: 'ark_plus',
  },
  {
    catalogKey: 'gift_circle',
    name: 'The Fold Gift',
    description: 'Gift access to the Fold (Circle).',
    entitlements: 'circle',
    tierCatalogKey: 'circle',
  },
  {
    catalogKey: 'gift_bundle',
    name: 'Ark+ & The Fold Gift',
    description: 'Gift the private ad-free feed and access to the Fold.',
    entitlements: 'ark_plus,circle',
    tierCatalogKey: 'bundle',
  },
]

// --- Guards ----------------------------------------------------------------

// The key must match the mode asked for: a test key without --live, a live key
// with it. Refusing the mismatch both ways means a stray `--live` can't silently
// run against test, and a live key left in .env can't be written to by a plain
// `--apply`.
function assertKeyMode(key: string | undefined, live: boolean): asserts key is string {
  if (!key) {
    console.error('STRIPE_SECRET_KEY is not set. Add your TEST key (sk_test_…) to .env.')
    process.exit(1)
  }
  const prefix = live ? 'sk_live_' : 'sk_test_'
  if (!key.startsWith(prefix)) {
    console.error(
      live
        ? 'Refusing to run: --live was passed but STRIPE_SECRET_KEY is not a live key (sk_live_…).'
        : 'Refusing to run: STRIPE_SECRET_KEY is not a test key (must start with "sk_test_").\n' +
            'Pass --live (and, to write, CONFIRM_LIVE_ACCOUNT=acct_…) to provision live mode.',
    )
    process.exit(1)
  }
}

// A live write names its target twice: once by key, once by account id. Catches
// the key for the wrong account (staging vs production, say) before any write.
async function assertLiveAccount(stripe: Stripe): Promise<void> {
  const expected = process.env.CONFIRM_LIVE_ACCOUNT
  const account = await stripe.accounts.retrieveCurrent()
  if (!expected || expected !== account.id) {
    console.error(
      `Refusing to write to LIVE: this key belongs to ${account.id}` +
        `${account.settings?.dashboard?.display_name ? ` (${account.settings.dashboard.display_name})` : ''}. ` +
        'Re-run with CONFIRM_LIVE_ACCOUNT set to that id to confirm.',
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

// Gift products carry kind:'gift' and no founding metadata.
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

// Sandbox orphans — products without our `catalog_key` marker. Anything active
// without that marker. Report by default; archive only with --archive-orphans,
// and only after checkout is on the catalog so we don't archive the product
// a live test checkout still points at.
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
// One percentage only fits while half the bundle is below BOTH standalone
// prices. At Ark+ $8 and bundle $25, half the bundle is $12.50, so a
// debundler keeping Ark+ already lands cheaper and this goes negative —
// see the skip in upsertIntroCoupon. Softening the Fold side ($19, i.e.
// $6.50/mo above the in-bundle half) would need a per-axis coupon, which is a
// change to server/lib/retention.ts, not to this script.
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

  // Non-positive means there is no discount to mint: half the bundle already
  // costs more than the standalone price, so the debundler lands cheaper
  // unaided. Stripe rejects percent_off <= 0 outright, and the server reads a
  // missing coupon as "settle at the standalone catalog price" (retention.ts
  // debundlePricePreview) — which is exactly the right landing here.
  if (percentOff <= 0) {
    console.log(
      `  coupon: SKIP — half the bundle is already dearer than the standalone ` +
        `price (${percentOff}%), so a debundler needs no intro rate.`,
    )
    return
  }

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
  const live = args.includes('--live')

  const key = process.env.STRIPE_SECRET_KEY
  assertKeyMode(key, live)
  if (live && archiveOrphans) {
    console.error('Refusing --archive-orphans in live mode.')
    process.exit(1)
  }
  const stripe = new Stripe(key)
  if (live && apply) await assertLiveAccount(stripe)

  const mode = live ? 'LIVE' : 'TEST'
  console.log(apply ? `=== APPLY (writing to Stripe ${mode} mode) ===` : `=== PREVIEW (${mode}, no writes) ===`)

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
      ? `\nDone. Catalog is provisioned. Verify prices by lookup_key in the Dashboard (${mode.toLowerCase()} mode).`
      : '\nPreview only — nothing was written. Re-run with --apply to provision.',
  )
}

main().catch((err) => {
  console.error('[stripe-catalog] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
