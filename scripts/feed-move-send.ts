// ICMB launch — the "move your feed" send, on launch day (Oct 5). The Fold
// welcome offer follows the next day (scripts/welcome-offer-send.ts).
//
// Emails every subscriber who predates launch, through Resend, each with an
// auto-login link to /setup. The audience is the welcome offer's — live Stripe
// subscriptions created before WELCOME_OFFER_ELIGIBLE_BEFORE_ISO — minus the
// offer's own eligibility rules: everyone carried over from the old feed has to
// move it, whatever their plan.
//
// Stripe is also the send ledger: a mailed customer is stamped with
// `feed_move_sent_at`, and a re-run skips them. So a run that dies halfway (or
// hits a Resend blip) is finished by running it again. Each send also carries a
// Resend idempotency key, which covers the gap between a send going out and the
// stamp landing.
//
// Dry run by default: lists who would be mailed and why anyone was skipped.
// Test mode by default, with the same live guardrails as the welcome offer.
//
// Usage:
//   bun run scripts/feed-move-send.ts                         # dry run
//   bun run scripts/feed-move-send.ts --only=me@example.com   # one member
//   bun run scripts/feed-move-send.ts --apply
//   STRIPE_SECRET_KEY=sk_live_… CONFIRM_LIVE_ACCOUNT=acct_… \
//     bun run scripts/feed-move-send.ts --live --apply
//
// Needs STRIPE_SECRET_KEY, RESEND_API_KEY (to send), APP_BASE_URL (links AND
// images: the email's art is served from that deployment's /email and /shows),
// and the session secret that signs email-login links for that environment.
// Bun auto-loads .env.

import Stripe from 'stripe'
import { sendEmail, withEmailUtm } from '../server/lib/email.js'
import { renderFeedMoveEmail } from '../server/lib/feed-move-email.js'
import { emailLoginUrl } from '../server/lib/session.js'
import { WELCOME_OFFER_ELIGIBLE_BEFORE_ISO } from '../server/lib/welcome-offer.js'
import { LIVE_SUB_STATUSES } from '../server/routes/stripe/helpers.js'

const SENT_AT_KEY = 'feed_move_sent_at'
const CAMPAIGN = 'icmb_launch_2026'

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

type Recipient = { customerId: string; email: string }

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

  const recipients: Recipient[] = []
  const seen = new Set<string>()
  const skipped = new Map<string, number>()
  const skip = (why: string) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

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
    if (customer.metadata?.[SENT_AT_KEY]) {
      skip('already sent')
      continue
    }
    recipients.push({ customerId: customer.id, email })
  }

  console.log(
    `[feed-move] ${live ? 'LIVE' : 'test'} mode, ${apply ? 'SENDING' : 'dry run'}: ` +
      `${recipients.length} to mail (images from ${appBaseUrl})`,
  )
  for (const [why, n] of skipped) console.log(`    skipped ${n}: ${why}`)
  for (const r of recipients.slice(0, 10)) console.log(`    ${r.email}`)
  if (recipients.length > 10) console.log(`    …and ${recipients.length - 10} more`)
  if (!apply) {
    console.log('    (pass --apply to send)')
    return
  }

  let sent = 0
  let failed = 0
  for (const r of recipients) {
    const { subject, html } = renderFeedMoveEmail({
      assetBaseUrl: appBaseUrl,
      setupUrl: await emailLoginUrl(
        appBaseUrl,
        withEmailUtm('/setup', 'feed-move'),
        { email: r.email },
        env,
      ),
    })
    const ok = await sendEmail(env, {
      to: r.email,
      subject,
      html,
      idempotencyKey: `feed_move_${CAMPAIGN}_${r.customerId}`,
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
  console.log(`[feed-move] sent ${sent}, failed ${failed}${failed ? ' — re-run to retry' : ''}`)
}

main().catch((err) => {
  console.error('[feed-move] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
