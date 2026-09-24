// ICMB launch welcome offer — the two Stripe coupons.
//
// Existing Inside Call Me Back subscribers move from Ark+ to the Bundle keeping
// their cadence, at a fixed discounted price for a fixed term:
//
//   yearly   $200 for the first year, then $250   (duration: once)
//   monthly  $20 for the first 3 months, then $25 (duration: repeating × 3)
//
// Mailed 2026-10-05, redeemable through 2026-10-31. Every redemption date in
// that window puts the third monthly bill in December and the first full-price
// one in January 2027, which is what the offer promises.
//
// Fixed `amount_off`, not `percent_off`, for two reasons. The offer is quoted as
// prices, not a percentage; and a percentage applies per line item, so it would
// also shave the proration CREDIT the upgrade raises for the member's unused
// Ark+ time, making the amount due impossible to state in the email.
// `applies_to.products` pins it to the Bundle product, so the discount can only
// touch the Bundle line and never that credit.
//
// The non-USD amounts are derived from the catalog's own Bundle prices rather
// than a table pasted in here: $200/yr and $20/mo are exactly the catalog's
// $20-per-month anchor, so each currency's offer price is its Bundle price
// scaled by 20/25 and rounded with the same `roundMinorFor` the rest of the
// server derives amounts with (whole units for HUF/TWD). A currency's discount
// is then simply Bundle − offer, and can never drift from what is really
// charged.
//
// Idempotent: coupons are addressed by a fixed id. Stripe coupons are immutable
// apart from name/metadata, so a re-run does NOT edit amounts — it re-reads the
// existing coupon and reports whether it still matches what this script would
// create. If it doesn't, delete it and re-run (safe before anyone has redeemed;
// deleting a coupon does not remove it from subscriptions already carrying it).
//
// Test mode by default. STRIPE_SECRET_KEY must start with `sk_test_` unless
// `--live` is passed, and a live write additionally needs CONFIRM_LIVE_ACCOUNT
// set to the live account id, checked against the key before anything is
// written.
//
// Usage:
//   bun run scripts/welcome-offer-coupons.ts                  # preview
//   bun run scripts/welcome-offer-coupons.ts --apply
//   bun run scripts/welcome-offer-coupons.ts --apply --max-redemptions=1200
//   STRIPE_SECRET_KEY=sk_live_… CONFIRM_LIVE_ACCOUNT=acct_… \
//     bun run scripts/welcome-offer-coupons.ts --live --apply

import Stripe from 'stripe'
import {
  resolveCatalogPrice,
  SUPPORTED_CURRENCIES,
  type Plan,
  type SupportedCurrency,
} from '../server/lib/pricing.js'
import {
  offerAmountFor,
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_COUPON_ID,
  WELCOME_OFFER_REDEEM_BY_ISO,
  WELCOME_OFFER_USD_MINOR,
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
} from '../server/lib/welcome-offer.js'

type Plans = readonly Plan[]
const PLANS: Plans = ['yearly', 'monthly']

// --- Guardrails -------------------------------------------------------------

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

// --- Amounts ----------------------------------------------------------------

type OfferAmounts = {
  productId: string
  // Per currency: what the Bundle costs, what this offer charges, and the
  // difference — which is the coupon's amount_off in that currency.
  rows: Array<{ currency: SupportedCurrency; bundle: number; offer: number; off: number }>
}

// The offer's amounts for one cadence, derived from the live catalog Bundle
// price by the shared offerAmountFor — the same arithmetic the account page
// uses, so what is minted and what is shown can't diverge. Throws if USD
// doesn't land exactly on the quoted figure: that means the Bundle price moved
// and the offer needs re-quoting, not silently re-scaling.
async function amountsFor(stripe: Stripe, plan: Plan): Promise<OfferAmounts> {
  const bundle = await resolveCatalogPrice(stripe, 'bundle', plan)
  const usdTarget = WELCOME_OFFER_USD_MINOR[plan]

  const rows = SUPPORTED_CURRENCIES.map((currency) => {
    const a = offerAmountFor(bundle.floors, plan, currency)
    return { currency, bundle: a.bundleMinor, offer: a.offerMinor, off: a.discountMinor }
  })

  const usd = rows.find((r) => r.currency === 'usd')!
  if (usd.offer !== usdTarget) {
    throw new Error(
      `Bundle ${plan} is ${usd.bundle} usd minor units, which scales to ${usd.offer} — ` +
        `not the quoted ${usdTarget}. Re-quote the offer before provisioning.`,
    )
  }
  for (const r of rows) {
    if (r.off <= 0) {
      throw new Error(`${r.currency} ${plan}: discount computed as ${r.off}, which is not chargeable.`)
    }
  }
  return { productId: bundle.productId, rows }
}

function couponParams(
  plan: Plan,
  amounts: OfferAmounts,
  maxRedemptions: number | null,
): Stripe.CouponCreateParams {
  const usd = amounts.rows.find((r) => r.currency === 'usd')!
  const currency_options: Record<string, { amount_off: number }> = {}
  for (const r of amounts.rows) {
    if (r.currency === 'usd') continue // usd is the coupon's base currency
    currency_options[r.currency] = { amount_off: r.off }
  }
  return {
    id: WELCOME_OFFER_COUPON_ID[plan],
    name:
      plan === 'yearly'
        ? 'ICMB welcome offer — first year'
        : 'ICMB welcome offer — first 3 months',
    amount_off: usd.off,
    currency: 'usd',
    currency_options,
    // Yearly spends the whole discount on the one invoice the upgrade raises,
    // which IS the member's first Bundle year. Monthly repeats across that
    // invoice and the next two.
    ...(plan === 'yearly'
      ? { duration: 'once' as const }
      : { duration: 'repeating' as const, duration_in_months: WELCOME_MONTHLY_DISCOUNT_MONTHS }),
    // Pins the discount to the Bundle line. Without this it could also land on
    // the credit for the member's unused Ark+ time on the same invoice.
    applies_to: { products: [amounts.productId] },
    redeem_by: Math.floor(Date.parse(WELCOME_OFFER_REDEEM_BY_ISO) / 1000),
    ...(maxRedemptions != null ? { max_redemptions: maxRedemptions } : {}),
    metadata: {
      // Never surfaced as the site-wide sale by pickAutoApplyPromo.
      auto_apply: 'false',
      campaign: WELCOME_OFFER_COHORT,
      plan,
    },
  }
}

// What a re-run compares against: the fields that decide what a member is
// charged. Name, metadata and max_redemptions are editable after the fact and
// deliberately not part of the check.
function describesSameOffer(
  existing: Stripe.Coupon,
  wanted: Stripe.CouponCreateParams,
): string[] {
  const drift: string[] = []
  if (existing.amount_off !== wanted.amount_off) {
    drift.push(`amount_off ${existing.amount_off} ≠ ${wanted.amount_off}`)
  }
  if (existing.currency !== wanted.currency) {
    drift.push(`currency ${existing.currency} ≠ ${wanted.currency}`)
  }
  if (existing.duration !== wanted.duration) {
    drift.push(`duration ${existing.duration} ≠ ${wanted.duration}`)
  }
  if ((existing.duration_in_months ?? null) !== (wanted.duration_in_months ?? null)) {
    drift.push(
      `duration_in_months ${existing.duration_in_months ?? 'null'} ≠ ${wanted.duration_in_months ?? 'null'}`,
    )
  }
  if ((existing.redeem_by ?? null) !== (wanted.redeem_by ?? null)) {
    drift.push(`redeem_by ${existing.redeem_by ?? 'null'} ≠ ${wanted.redeem_by ?? 'null'}`)
  }
  const wantedProducts = wanted.applies_to?.products ?? []
  const existingProducts = existing.applies_to?.products ?? []
  if (existingProducts.join(',') !== wantedProducts.join(',')) {
    drift.push(`applies_to.products [${existingProducts}] ≠ [${wantedProducts}]`)
  }
  for (const [cur, opt] of Object.entries(wanted.currency_options ?? {})) {
    const have = existing.currency_options?.[cur]?.amount_off
    if (have !== opt.amount_off) drift.push(`${cur} amount_off ${have ?? 'missing'} ≠ ${opt.amount_off}`)
  }
  return drift
}

function fmtRows(amounts: OfferAmounts, limit = 6): string {
  return amounts.rows
    .slice(0, limit)
    .map((r) => `${r.currency} ${r.bundle}→${r.offer} (−${r.off})`)
    .join(' · ')
    .concat(amounts.rows.length > limit ? ` · …${amounts.rows.length - limit} more` : '')
}

// --- Main -------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const live = args.includes('--live')
  const maxArg = args.find((a) => a.startsWith('--max-redemptions='))
  const maxRedemptions = maxArg ? Number(maxArg.split('=')[1]) : null
  if (maxRedemptions != null && (!Number.isInteger(maxRedemptions) || maxRedemptions < 1)) {
    console.error('--max-redemptions must be a positive integer.')
    process.exit(1)
  }

  const key = process.env.STRIPE_SECRET_KEY
  assertKeyMode(key, live)
  const stripe = new Stripe(key)
  if (live && apply) await assertLiveAccount(stripe)

  console.log(
    `[welcome-offer] ${live ? 'LIVE' : 'TEST'} mode, ${apply ? 'APPLYING' : 'preview only'}` +
      `; redeemable until ${WELCOME_OFFER_REDEEM_BY_ISO}` +
      `${maxRedemptions != null ? `, max ${maxRedemptions} redemptions` : ''}`,
  )

  for (const plan of PLANS) {
    const amounts = await amountsFor(stripe, plan)
    const wanted = couponParams(plan, amounts, maxRedemptions)
    const id = WELCOME_OFFER_COUPON_ID[plan]

    let existing: Stripe.Coupon | null = null
    try {
      existing = await stripe.coupons.retrieve(id)
    } catch {
      existing = null
    }

    console.log(`\n  ${id} (${plan})`)
    console.log(`    ${wanted.duration}${wanted.duration_in_months ? ` × ${wanted.duration_in_months}` : ''}, applies to ${amounts.productId}`)
    console.log(`    ${fmtRows(amounts)}`)

    if (existing) {
      const drift = describesSameOffer(existing, wanted)
      if (drift.length === 0) {
        console.log('    ✓ already provisioned and matching')
      } else {
        console.error('    ✗ EXISTS BUT DIFFERS — coupons are immutable; delete and re-run:')
        for (const d of drift) console.error(`        ${d}`)
        process.exitCode = 1
      }
      continue
    }

    if (!apply) {
      console.log('    would create (pass --apply)')
      continue
    }
    const created = await stripe.coupons.create(wanted)
    console.log(`    ✓ created ${created.id}`)
  }
}

main().catch((err) => {
  console.error('[welcome-offer] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
