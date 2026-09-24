// Contact form route.
//
//   POST /api/contact — public. Forwards a "Get in touch" submission to the
//     inbox for the chosen topic via Resend. The form replaces the old
//     mailto: links on /contact so visitors never see the raw addresses.
//     A listener question must name a show. After the email is sent, every
//     submission is also posted to a Make webhook that files it in the team's
//     "Get in touch" Airtable.
//
// Validation is strict and the body is HTML-escaped before it goes into the
// email, since every field is attacker-controlled. Same-origin only, rate-limited
// per IP, and capped per day across ALL callers, to keep the form from being
// used as a spam relay into our own inboxes. Both limits are the shared
// (Neon-backed) kind: each call sends mail, and an in-memory bucket is one per
// function instance.

import { fetchWithTimeout, getClientIp, isSameOrigin, readJson } from '../lib/http.js'
import { createSharedRateLimiter } from '../lib/shared-rate-limit.js'
import { sendEmail } from '../lib/email.js'
import { defineRoute, type Deps, type Route } from '../lib/route.js'
import { contactTopics } from '../../src/config/urls.js'
import { getShow, isListenerQuestionShow } from '../../src/data/shows.js'
import { escapeHtml, isValidEmail } from '../../shared/validation.js'

const NAME_MAX = 200
const MESSAGE_MAX = 5000
// The sender's name rides in the subject so the inbox is scannable, but only a
// tidy slice of it: a subject is a header, and a 200-character name is not one.
const SUBJECT_NAME_MAX = 80

// The whole site's contact mail for a day. Far above any honest day's volume;
// low enough that a distributed flood (many IPs, each inside its own budget)
// runs out before it buries the inboxes or the Resend quota.
const DAILY_CEILING = 200
const DAILY_KEY = 'all'

// The name as it appears in the subject line. Control characters — CR, LF and
// tab among them — become spaces so nothing typed into the form can break out of
// the header or fold it, runs of whitespace collapse, and the result is capped.
// The body shows the full (escaped) name; this is only the subject's copy.
export function subjectSafeName(name: string): string {
  const flat = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > SUBJECT_NAME_MAX ? `${flat.slice(0, SUBJECT_NAME_MAX - 1)}…` : flat
}

const topicsByValue = new Map(contactTopics.map((t) => [t.value, t]))

const WEBHOOK_TIMEOUT_MS = 5000

// Files a submission in the team's "Get in touch" Airtable, via a Make
// "Custom webhook" scenario the team owns (MAKE_CONTACT_WEBHOOK_URL). The key
// goes in Make's API-key header; Make answers 401 without it.
//
// Best effort, and only ever after the email went out: the inbox is the record
// of the submission, so a Make outage is logged rather than shown to the
// sender, and a failed email (which the sender will retry) never leaves a row
// behind to be duplicated. The slugs are the stable handles for filtering in
// Make (e.g. CPP questions → their own table); `topic` and `show` are display
// names, which change when a label or a show is renamed. `show`/`showSlug` are
// empty strings on anything but a listener question.
async function fileInAirtable(
  env: Deps['env'],
  payload: {
    name: string
    email: string
    topic: string
    topicSlug: string
    show: string
    showSlug: string
    message: string
  },
): Promise<void> {
  const url = env.MAKE_CONTACT_WEBHOOK_URL
  if (!url) {
    console.warn('[contact] MAKE_CONTACT_WEBHOOK_URL unset; submission not sent to Airtable')
    return
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const key = env.MAKE_CONTACT_WEBHOOK_KEY
  if (key) headers['x-make-apikey'] = key
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ submittedAt: new Date().toISOString(), ...payload }),
      },
      WEBHOOK_TIMEOUT_MS,
    )
    if (!res.ok) {
      console.error(`[contact] Make webhook answered ${res.status}`)
    }
  } catch (err) {
    console.error('[contact] Make webhook failed', err)
  }
}

export function contactRoutes({ env, appBaseUrl }: Deps): Route[] {
  // A contact form is low-frequency per person: 5-message burst, then ~1 every
  // 10s. Enough for an honest sender who fixes a typo; too slow to relay spam.
  const limiter = createSharedRateLimiter(env, {
    name: 'contact-ip',
    capacity: 5,
    refillPerSec: 0.1,
  })
  // One bucket for everyone (constant key), refilling over a day.
  const dailyLimiter = createSharedRateLimiter(env, {
    name: 'contact-daily',
    capacity: DAILY_CEILING,
    refillPerSec: DAILY_CEILING / 86_400,
  })

  return [
    defineRoute({
      path: '/api/contact',
      method: 'POST',
      handler: async (req, res, json) => {
        // This sends mail and has no business being called from anywhere but
        // the site itself. Same check as /api/support/log.
        if (!isSameOrigin(req, appBaseUrl)) {
          return json(403, { error: 'bad_origin' })
        }

        const wait = await limiter.take(getClientIp(req))
        if (wait !== null) {
          res.setHeader('retry-after', String(wait))
          return json(429, { error: 'too_many_requests' })
        }

        const body = await readJson<{
          name?: unknown
          email?: unknown
          topic?: unknown
          show?: unknown
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
        if (!isValidEmail(email)) {
          return json(400, { error: 'invalid_email' })
        }
        const topic = topicsByValue.get(topicValue as never)
        if (!topic) {
          return json(400, { error: 'invalid_topic' })
        }
        // Only a listener question carries a show, and it must carry one.
        const showValue = body?.show
        const show =
          topic.value === 'questions' && isListenerQuestionShow(showValue)
            ? getShow(showValue)
            : undefined
        if (topic.value === 'questions' && !show) {
          return json(400, { error: 'invalid_show' })
        }
        if (!message || message.length > MESSAGE_MAX) {
          return json(400, { error: 'invalid_message' })
        }

        // Spent only by a submission that is about to send: junk that failed
        // validation above, and the honeypot, must not be able to drain the
        // day's budget for everyone else. The refusal is byte-for-byte the
        // per-IP one — same status, same body, and no retry-after that would
        // give the day-long refill away — so a caller can't tell which limit
        // they hit, or that a global one exists.
        if ((await dailyLimiter.take(DAILY_KEY)) !== null) {
          console.warn('[contact] daily send ceiling reached; refusing submission')
          return json(429, { error: 'too_many_requests' })
        }

        const html =
          `<p><strong>From:</strong> ${escapeHtml(name)} ` +
          `(${escapeHtml(email)})</p>` +
          `<p><strong>Topic:</strong> ${escapeHtml(topic.label)}</p>` +
          (show ? `<p><strong>Show:</strong> ${escapeHtml(show.title)}</p>` : '') +
          `<p><strong>Message:</strong></p>` +
          `<p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`

        const sent = await sendEmail(env, {
          to: topic.email,
          subject: `[Contact — ${topic.label}${show ? ` — ${show.title}` : ''}] ${subjectSafeName(name) || '(no name)'}`,
          html,
          replyTo: email,
        })
        if (!sent) {
          return json(502, { error: 'send_failed' })
        }

        await fileInAirtable(env, {
          name,
          email,
          topic: topic.label,
          topicSlug: topic.value,
          show: show?.title ?? '',
          showSlug: show?.slug ?? '',
          message,
        })

        return json(200, { ok: true })
      },
    }),
  ]
}
