// Setup-SMS sender.
//
// Asks SC to text the signed-in user a link for setting up their feed. SC's
// endpoint expects E.164 (+15555555555); we normalize loosely and let SC
// return 422 for anything it can't route. Local rate limit on top of SC's
// own — these are paid SMS, so abuse is expensive.

import { isSameOrigin, makeJsonRes, readJson } from '../lib/http.js'
import { getSessionEmail } from '../lib/session.js'
import {
  createScClient,
  findScUserByEmail,
  type ScError,
  type ScUserFeed,
} from '../lib/sc-client.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import type { Deps, Route } from '../lib/route.js'

export function smsRoutes({ env, appBaseUrl }: Deps): Route[] {
  // SMS setup-link sender. Tight budget — SC forwards these to a carrier
  // and charges per message.
  const smsLimiter = createRateLimiter({
    capacity: 3,
    refillPerSec: 3 / (60 * 60), // 3 per hour per session
  })

  return [
    {
      path: '/api/sc/send-setup-sms',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' })

        // Cookie-authenticated mutation that triggers paid SMS — apply the same
        // same-origin CSRF guard as other state-changing routes (see http.ts).
        if (!isSameOrigin(req, appBaseUrl)) return json(403, { error: 'bad_origin' })

        const smsEmail = await getSessionEmail(req, env)
        if (!smsEmail) return json(401, { error: 'unauthenticated' })

        const smsSc = createScClient(env)
        const smsUser = await findScUserByEmail(smsSc, smsEmail)
        if (!smsUser) return json(401, { error: 'membership_not_found' })

        const wait = smsLimiter.take(String(smsUser.id))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, {
            error: 'Too many SMS requests. Please wait a bit and try again.',
          })
        }

        const body = (await readJson<{ phone?: unknown; feed_id?: unknown }>(req)) ?? {}
        if (typeof body.phone !== 'string') {
          return json(400, { error: 'Phone number is required.' })
        }
        const rawPhone = body.phone.trim()
        if (!rawPhone) return json(400, { error: 'Phone number is required.' })

        // feed_id is optional but, if provided, must be a positive integer.
        // It gets interpolated into the SC path, so runtime-validate rather
        // than trusting the TS type.
        let feedId: number | undefined
        if (body.feed_id !== undefined) {
          if (
            typeof body.feed_id !== 'number' ||
            !Number.isInteger(body.feed_id) ||
            body.feed_id <= 0
          ) {
            return json(400, { error: 'Invalid feed id.' })
          }
          feedId = body.feed_id
        }

        // Normalize to E.164: remember whether the input carried a leading
        // +, strip everything else to digits, then rebuild. Bare 10-digit
        // input is assumed US (+1) — consistent with the audience default.
        const hadPlus = rawPhone.startsWith('+')
        const digits = rawPhone.replace(/\D/g, '')
        let phone: string
        if (hadPlus) {
          phone = `+${digits}`
        } else if (digits.length === 10) {
          phone = `+1${digits}`
        } else if (digits.length === 11 && digits.startsWith('1')) {
          phone = `+${digits}`
        } else {
          phone = `+${digits}`
        }
        const digitCount = phone.length - 1 // excludes the leading +
        if (digitCount < 8 || digitCount > 15) {
          return json(400, { error: "That doesn't look like a valid phone number." })
        }

        try {
          // Resolve the target feed — prefer the explicit feed_id, else the
          // first feed on the account (matches what SetupFlow displays).
          if (!feedId) {
            const feedsRes = await smsSc.call<{ feeds: ScUserFeed[] }>(
              'GET',
              `/users/${smsUser.id}/feeds`,
            )
            feedId = feedsRes.feeds?.[0]?.id
          }
          if (!feedId) return json(404, { error: 'No feed found for this account.' })

          await smsSc.call(
            'POST',
            `/users/${smsUser.id}/feeds/${feedId}/send_setup_sms`,
            { phone },
          )
          json(200, { ok: true })
        } catch (err) {
          const e = err as ScError
          if (e.status === 422) {
            return json(422, {
              error: "We couldn't send to that number. Check the format and try again.",
            })
          }
          if (e.status === 429) {
            return json(429, { error: 'SMS rate limit reached. Try again in a moment.' })
          }
          console.error('[dev-api] send_setup_sms failed:', err)
          json(e.status ?? 502, { error: 'Could not send SMS. Please try again.' })
        }
      },
    },
  ]
}
