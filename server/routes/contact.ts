// Contact form route.
//
//   POST /api/contact — public. Forwards a "Get in touch" submission to the
//     inbox for the chosen topic via Resend. The form replaces the old
//     mailto: links on /contact so visitors never see the raw addresses.
//
// Validation is strict and the body is HTML-escaped before it goes into the
// email, since every field is attacker-controlled. Rate-limited per IP to keep
// the form from being used as a spam relay.

import { getClientIp, makeJsonRes, readJson } from '../lib/http.js'
import { createRateLimiter } from '../lib/rate-limit.js'
import { sendEmail } from '../lib/email.js'
import type { Deps, Route } from '../lib/route.js'
import { contactTopics } from '../../src/config/urls.js'

const NAME_MAX = 200
const MESSAGE_MAX = 5000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const topicsByValue = new Map(contactTopics.map((t) => [t.value, t]))

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function contactRoutes({ env }: Deps): Route[] {
  // A contact form is low-frequency per person: 5-message burst, then ~1 every
  // 10s. Enough for an honest sender who fixes a typo; too slow to relay spam.
  const limiter = createRateLimiter({ capacity: 5, refillPerSec: 0.1 })

  return [
    {
      path: '/api/contact',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        if (req.method !== 'POST') {
          return json(405, { error: 'Method Not Allowed' })
        }

        const wait = limiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const body = await readJson<{
          name?: unknown
          email?: unknown
          topic?: unknown
          message?: unknown
          company?: unknown
        }>(req)

        // Honeypot: a hidden field real users never fill. Bots that fill every
        // input trip it. Pretend success so they don't learn to adapt.
        if (typeof body?.company === 'string' && body.company.trim() !== '') {
          return json(200, { ok: true })
        }

        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        const email = typeof body?.email === 'string' ? body.email.trim() : ''
        const topicValue = typeof body?.topic === 'string' ? body.topic : ''
        const message =
          typeof body?.message === 'string' ? body.message.trim() : ''

        if (!name || name.length > NAME_MAX) {
          return json(400, { error: 'invalid_name' })
        }
        if (!EMAIL_RE.test(email)) {
          return json(400, { error: 'invalid_email' })
        }
        const topic = topicsByValue.get(topicValue as never)
        if (!topic) {
          return json(400, { error: 'invalid_topic' })
        }
        if (!message || message.length > MESSAGE_MAX) {
          return json(400, { error: 'invalid_message' })
        }

        const html =
          `<p><strong>From:</strong> ${escapeHtml(name)} ` +
          `(${escapeHtml(email)})</p>` +
          `<p><strong>Topic:</strong> ${escapeHtml(topic.label)}</p>` +
          `<p><strong>Message:</strong></p>` +
          `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`

        const sent = await sendEmail(env, {
          to: topic.email,
          subject: `[Contact — ${topic.label}] ${name}`,
          html,
          replyTo: email,
        })
        if (!sent) {
          return json(502, { error: 'send_failed' })
        }

        return json(200, { ok: true })
      },
    },
  ]
}
