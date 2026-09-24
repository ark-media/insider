// ICMB launch welcome offer — the launch-day send.
//
// Emails every Ark+ subscriber who predates launch their welcome offer, through
// Resend, each with an auto-login link to /offer. The audience is read straight
// from Stripe by the same blockFor the redeem route uses, so whoever is mailed
// is exactly whoever may redeem — there is no roster to generate or keep in
// sync.
//
// Stripe is also the send ledger: a mailed customer is stamped with
// `welcome_offer_sent_at`, and a re-run skips them. So a run that dies halfway
// (or hits a Resend blip) is finished by running it again. Each send also
// carries a Resend idempotency key, which covers the gap between a send going
// out and the stamp landing.
//
// Dry run by default: lists who would be mailed, at what price, and why anyone
// was skipped. Test mode by default, with the same live guardrails as
// scripts/welcome-offer-coupons.ts.
//
// Usage:
//   bun run scripts/welcome-offer-send.ts                         # dry run
//   bun run scripts/welcome-offer-send.ts --only=me@example.com   # one member
//   bun run scripts/welcome-offer-send.ts --apply
//   STRIPE_SECRET_KEY=sk_live_… CONFIRM_LIVE_ACCOUNT=acct_… \
//     bun run scripts/welcome-offer-send.ts --live --apply
//
// Needs STRIPE_SECRET_KEY, RESEND_API_KEY (to send), APP_BASE_URL, and the
// session secret that signs email-login links for the environment the links
// will land on. Bun auto-loads .env.

import Stripe from 'stripe'
import { sendEmail } from '../server/lib/email.js'
import {
  formatMinorUnits,
  resolveCatalogPrice,
  isSupportedCurrency,
  type Plan,
} from '../server/lib/pricing.js'
import { emailLoginUrl } from '../server/lib/session.js'
import {
  blockFor,
  offerAmountFor,
  WELCOME_MONTHLY_DISCOUNT_MONTHS,
  WELCOME_OFFER_COHORT,
  WELCOME_OFFER_ELIGIBLE_BEFORE_ISO,
} from '../server/lib/welcome-offer.js'
import { renderWelcomeOfferEmail } from '../server/lib/welcome-offer-email.js'
import { LIVE_SUB_STATUSES, planFromSubscription } from '../server/routes/stripe/helpers.js'
import { catalogTierOfSubscription } from '../server/routes/stripe/webhook.js'
import { greetingFirstName } from '../shared/profile-name.js'
import type { Tier } from '../server/entitlement.js'

const SENT_AT_KEY = 'welcome_offer_sent_at'

// Resend's default ceiling is 2 requests a second; stay under it.
const SEND_GAP_MS = 600

async function assertMode(stripe: Stripe, key: string | undefined, live: boolean): Promise<void> {
  const prefix = live ? 'sk_live_' : 'sk_test_'
  if (!key?.startsWith(prefix)) {
    console.error(
      live
        ? 'Refusing to run: --live was passed but STRIPE_SECRET_KEY is not a live key.'
        : 'Refusing to run: STRIPE_SECRET_KEY is not a test key. Pass --live for live mode.',
    )
    process.exit(1)
  }
  if (!live) return
  const account = await stripe.accounts.retrieveCurrent()
  if (process.env.CONFIRM_LIVE_ACCOUNT !== account.id) {
    console.error(
      `Refusing to run against LIVE: this key belongs to ${account.id}. ` +
        'Re-run with CONFIRM_LIVE_ACCOUNT set to that id to confirm.',
    )
    process.exit(1)
  }
}

type Recipient = {
  customerId: string
  email: string
  name: string | null
  plan: Plan
  currency: string
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const live = args.includes('--live')
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).toLowerCase()

  const env = process.env as Record<string, string>
  const key = env.STRIPE_SECRET_KEY
  const stripe = new Stripe(key ?? '')
  await assertMode(stripe, key, live)
  if (apply && !env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set — nothing could be sent.')
    process.exit(1)
  }
  const appBaseUrl = env.APP_BASE_URL || 'https://ark-plus.xyz'

  // One product lookup per product, not per subscription.
  const tierByProduct = new Map<string, Promise<Tier | null>>()
  const tierOf = (sub: Stripe.Subscription): Promise<Tier | null> => {
    const ref = sub.items.data[0]?.price?.product
    const id = typeof ref === 'string' ? ref : (ref?.id ?? '')
    let tier = tierByProduct.get(id)
    if (!tier) {
      tier = catalogTierOfSubscription(sub, stripe)
      tierByProduct.set(id, tier)
    }
    return tier
  }

  const recipients: Recipient[] = []
  const seen = new Set<string>()
  const skipped = new Map<string, number>()
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

  // `created.lt` lets Stripe drop everything after launch before it reaches us;
  // blockFor re-checks it anyway, so the two can't disagree.
  const cutoff = Math.floor(Date.parse(WELCOME_OFFER_ELIGIBLE_BEFORE_ISO) / 1000)
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    created: { lt: cutoff },
    expand: ['data.customer'],
    limit: 100,
  })) {
    if (!LIVE_SUB_STATUSES.has(sub.status)) continue
    const customer = sub.customer
    if (typeof customer === 'string' || customer.deleted) {
      skip('customer unreadable')
      continue
    }
    const email = customer.email?.trim().toLowerCase()
    if (!email) {
      skip('no email on customer')
      continue
    }
    if (only && email !== only) continue
    if (seen.has(email)) {
      skip('second subscription on the same email')
      continue
    }
    seen.add(email)

    const block = blockFor(sub, await tierOf(sub))
    if (block) {
      skip(block)
      continue
    }
    const plan = planFromSubscription(sub)
    if (!plan) {
      skip('cadence unreadable')
      continue
    }
    if (customer.metadata?.[SENT_AT_KEY]) {
      skip('already sent')
      continue
    }
    recipients.push({
      customerId: customer.id,
      email,
      name: customer.name ?? null,
      plan,
      currency: isSupportedCurrency(sub.currency) ? sub.currency : 'usd',
    })
  }

  const floors: Record<Plan, Record<string, number>> = {
    yearly: (await resolveCatalogPrice(stripe, 'bundle', 'yearly')).floors,
    monthly: (await resolveCatalogPrice(stripe, 'bundle', 'monthly')).floors,
  }
  const pricesFor = (r: Recipient) => {
    const a = offerAmountFor(floors[r.plan], r.plan, r.currency)
    return {
      offerPrice: formatMinorUnits(a.offerMinor, r.currency),
      bundlePrice: formatMinorUnits(a.bundleMinor, r.currency),
    }
  }

  console.log(
    `[welcome-offer] ${live ? 'LIVE' : 'test'} mode, ${apply ? 'SENDING' : 'dry run'}: ` +
      `${recipients.length} to mail`,
  )
  for (const [why, n] of skipped) console.log(`    skipped ${n}: ${why}`)
  for (const r of recipients.slice(0, 10)) {
    const p = pricesFor(r)
    console.log(`    ${r.email}  ${r.plan}  ${p.offerPrice} (list ${p.bundlePrice})`)
  }
  if (recipients.length > 10) console.log(`    …and ${recipients.length - 10} more`)
  if (!apply) {
    console.log('    (pass --apply to send)')
    return
  }

  let sent = 0
  let failed = 0
  for (const r of recipients) {
    const [first, ...rest] = (r.name ?? '').trim().split(/\s+/)
    const { subject, html } = renderWelcomeOfferEmail({
      firstName: greetingFirstName(first, r.email, rest.join(' ')),
      plan: r.plan,
      ...pricesFor(r),
      discountedMonths: WELCOME_MONTHLY_DISCOUNT_MONTHS,
      offerUrl: await emailLoginUrl(
        appBaseUrl,
        '/offer',
        // Lets this link, alone among our emails, redeem for its first 48 hours.
        { email: r.email, purpose: 'welcome_offer' },
        env,
      ),
    })
    const ok = await sendEmail(env, {
      to: r.email,
      subject,
      html,
      idempotencyKey: `welcome_offer_${WELCOME_OFFER_COHORT}_${r.customerId}`,
    })
    if (ok) {
      sent++
      try {
        await stripe.customers.update(r.customerId, {
          metadata: { [SENT_AT_KEY]: new Date().toISOString() },
        })
      } catch (err) {
        // Sent but not stamped: a re-run within Resend's 24h idempotency window
        // collapses the duplicate; after that it would mail them again.
        console.error(`    ! sent but not stamped: ${r.customerId}`, err)
      }
    } else {
      failed++
    }
    await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS))
  }
  console.log(`[welcome-offer] sent ${sent}, failed ${failed}${failed ? ' — re-run to retry' : ''}`)
}

main().catch((err) => {
  console.error('[welcome-offer] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
