import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import type { ServerResponse } from 'node:http'
import { makeFakeReq } from './test-utils'
import { contactRoutes, subjectSafeName } from './routes/contact'
import { contactTopics } from '../src/config/urls'
import { shows } from '../src/data/shows'
import { CONTACT_MESSAGE_MAX } from '../shared/validation'
import type { Deps } from './lib/route'

function makeReq(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: unknown
  ip?: string
}) {
  return makeFakeReq({
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/contact',
    headers: opts.headers,
    body: opts.body,
    remoteAddress: opts.ip,
  })
}

function makeRes(): ServerResponse & {
  statusCode: number
  body: string
  headers: Record<string, string>
} {
  const res = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k.toLowerCase()] = v
    },
    end(chunk?: string) {
      if (chunk) this.body += chunk
    },
  }
  return res as unknown as ServerResponse & {
    statusCode: number
    body: string
    headers: Record<string, string>
  }
}

function makeDeps(env: Record<string, string> = {}): Deps {
  return {
    env,
    stripe: null,
    appBaseUrl: 'http://localhost:5173',
    activator: {} as Deps['activator'],
  }
}

// Each call builds a fresh route set so the rate limiters start empty —
// otherwise bursts across tests would bleed into each other. No DATABASE_URL
// here, so the shared limiter is its in-memory fallback: same shape, same
// limits, no database (its Neon path is shared-rate-limit's own to test).
function getHandler(env: Record<string, string> = { RESEND_API_KEY: 'test' }) {
  const handler = contactRoutes(makeDeps(env)).find(
    (r) => r.path === '/api/contact',
  )?.handler
  if (!handler) throw new Error('no /api/contact handler')
  return handler
}

const VALID = {
  firstName: 'Jane',
  lastName: 'Listener',
  email: 'jane@example.com',
  topic: 'press',
  message: 'Loved the latest episode.\nCan we book an interview?',
}

// --- Fetch (Resend) mock ---------------------------------------------------
const originalFetch = globalThis.fetch
let lastInit: RequestInit | undefined
let resendStatus = 200
let fetchCalls = 0
// Every request, in order: Resend first, then (for a listener question) Make.
let calls: Array<{ url: string; init?: RequestInit }> = []
let webhookStatus = 200
let webhookThrows = false
const WEBHOOK_URL = 'https://hook.example.make.com/contact'

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  fetchCalls += 1
  lastInit = init
  const url = String(input)
  calls.push({ url, init })
  if (url === WEBHOOK_URL) {
    if (webhookThrows) throw new Error('network down')
    return new Response('Accepted', { status: webhookStatus })
  }
  return new Response('{}', { status: resendStatus })
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  lastInit = undefined
  resendStatus = 200
  fetchCalls = 0
  calls = []
  webhookStatus = 200
  webhookThrows = false
})

describe('/api/contact', () => {
  test('forwards a valid submission to the topic inbox with reply-to', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: VALID }), res)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(fetchCalls).toBe(1)

    const sent = JSON.parse(String(lastInit?.body)) as {
      to: string
      subject: string
      html: string
      reply_to: string
    }
    const press = contactTopics.find((t) => t.value === 'press')!
    expect(sent.to).toBe(press.email)
    expect(sent.reply_to).toBe('jane@example.com')
    expect(sent.subject).toContain('Jane Listener')
    expect(sent.html).toContain('Loved the latest episode.')
  })

  test('rejects a non-POST method', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ method: 'GET', body: undefined }), res)
    expect(res.statusCode).toBe(405)
  })

  test('rejects an invalid email without sending', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: { ...VALID, email: 'nope' } }), res)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('invalid_email')
    expect(fetchCalls).toBe(0)
  })

  test('rejects an unknown topic without sending', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: { ...VALID, topic: 'lawsuit' } }), res)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('invalid_topic')
    expect(fetchCalls).toBe(0)
  })

  test('rejects an empty message without sending', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: { ...VALID, message: '   ' } }), res)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body).error).toBe('invalid_message')
    expect(fetchCalls).toBe(0)
  })

  test('accepts a message at the limit and rejects one past it', async () => {
    const atLimit = makeRes()
    await getHandler()(makeReq({ body: { ...VALID, message: 'x'.repeat(CONTACT_MESSAGE_MAX) } }), atLimit)
    expect(atLimit.statusCode).toBe(200)

    const over = makeRes()
    await getHandler()(makeReq({ body: { ...VALID, message: 'x'.repeat(CONTACT_MESSAGE_MAX + 1) } }), over)
    expect(over.statusCode).toBe(400)
    expect(JSON.parse(over.body).error).toBe('invalid_message')
    expect(CONTACT_MESSAGE_MAX).toBe(1200)
  })

  test('HTML-escapes user input in the forwarded email', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(
      makeReq({
        body: { ...VALID, message: '<script>alert(1)</script>' },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const sent = JSON.parse(String(lastInit?.body)) as { html: string }
    expect(sent.html).not.toContain('<script>')
    expect(sent.html).toContain('&lt;script&gt;')
  })

  test('honeypot submission is silently accepted without sending', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: { ...VALID, company: 'AcmeBot' } }), res)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(fetchCalls).toBe(0)
  })

  test('surfaces a send failure as 502', async () => {
    resendStatus = 500
    const handler = getHandler()
    const res = makeRes()
    await handler(makeReq({ body: VALID }), res)
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBe('send_failed')
  })

  // The form sends mail on every accepted call, so it takes the same
  // same-origin gate as /api/support/log.
  test('rejects a cross-origin post without sending', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(
      makeReq({ body: VALID, headers: { origin: 'https://evil.example' } }),
      res,
    )
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toEqual({ error: 'bad_origin' })
    expect(fetchCalls).toBe(0)
  })

  test("accepts the site's own origin", async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(
      makeReq({ body: VALID, headers: { origin: 'http://localhost:5173' } }),
      res,
    )
    expect(res.statusCode).toBe(200)
    expect(fetchCalls).toBe(1)
  })

  // The subject is a mail header; the name in it is whatever was typed.
  test('keeps CR/LF, tabs and control characters out of the subject', async () => {
    const handler = getHandler()
    const res = makeRes()
    await handler(
      makeReq({
        body: { ...VALID, firstName: 'Jane\r\nBcc: victim@example.com\t\u0000  ' },
      }),
      res,
    )
    expect(res.statusCode).toBe(200)
    const sent = JSON.parse(String(lastInit?.body)) as { subject: string; html: string }
    // eslint-disable-next-line no-control-regex
    expect(sent.subject).not.toMatch(/[\u0000-\u001f\u007f]/)
    const press = contactTopics.find((t) => t.value === 'press')!
    expect(sent.subject).toBe(
      `[Contact — ${press.label}] Jane Bcc: victim@example.com Listener`,
    )
  })

  test('caps the name in the subject but keeps the fixed prefix and the full name in the body', async () => {
    const handler = getHandler()
    const res = makeRes()
    const longName = 'N'.repeat(200)
    await handler(makeReq({ body: { ...VALID, firstName: longName } }), res)
    expect(res.statusCode).toBe(200)
    const sent = JSON.parse(String(lastInit?.body)) as { subject: string; html: string }
    const fullName = `${longName} Listener`
    expect(sent.subject.startsWith('[Contact — ')).toBe(true)
    expect(subjectSafeName(fullName)).toHaveLength(80)
    expect(sent.subject.endsWith(subjectSafeName(fullName))).toBe(true)
    expect(sent.html).toContain(fullName)
  })

  // A flood spread over many IPs stays inside every per-IP budget; the daily
  // ceiling is what stops it. The refusal must not say which limit fired.
  test('stops sending once the global daily ceiling is spent, indistinguishably', async () => {
    const handler = getHandler()
    let refused: ReturnType<typeof makeRes> | null = null
    let accepted = 0
    for (let i = 0; i < 205 && !refused; i += 1) {
      const res = makeRes()
      await handler(makeReq({ body: VALID, ip: `10.0.${Math.floor(i / 250)}.${i % 250}` }), res)
      if (res.statusCode === 200) accepted += 1
      else refused = res
    }
    expect(accepted).toBe(200)
    expect(fetchCalls).toBe(200)
    expect(refused?.statusCode).toBe(429)

    // Byte-for-byte the per-IP refusal, minus the header that would give the
    // day-long refill away.
    expect(JSON.parse(refused!.body)).toEqual({ error: 'too_many_requests' })
    expect(refused!.headers['retry-after']).toBeUndefined()
  })

  test('invalid and honeypot submissions do not spend the daily budget', async () => {
    const handler = getHandler()
    for (let i = 0; i < 250; i += 1) {
      const body = i % 2 ? { ...VALID, email: 'nope' } : { ...VALID, company: 'AcmeBot' }
      await handler(makeReq({ body, ip: `10.1.0.${i}` }), makeRes())
    }
    const res = makeRes()
    await handler(makeReq({ body: VALID, ip: '10.2.0.1' }), res)
    expect(res.statusCode).toBe(200)
    expect(fetchCalls).toBe(1)
  })

  test('rate-limits a burst from one IP', async () => {
    const handler = getHandler()
    let limited = false
    // capacity is 5; the 6th from the same IP should be refused.
    for (let i = 0; i < 6; i += 1) {
      const res = makeRes()
      await handler(makeReq({ body: VALID, ip: '9.9.9.9' }), res)
      if (res.statusCode === 429) limited = true
    }
    expect(limited).toBe(true)
  })
})

describe('/api/contact — inboxes and Airtable', () => {
  const QUESTION = {
    ...VALID,
    topic: 'questions',
    show: 'chosen-people-problems',
    message: 'What is the best Shabbat dinner argument?',
  }
  const ENV = {
    RESEND_API_KEY: 'test',
    MAKE_CONTACT_WEBHOOK_URL: WEBHOOK_URL,
    MAKE_CONTACT_WEBHOOK_KEY: 'make-key',
  }

  test('support goes to support@, every other topic to hello@', () => {
    for (const t of contactTopics) {
      expect(t.email).toBe(t.value === 'support' ? 'support@arkmedia.org' : 'hello@arkmedia.org')
    }
  })

  test('emails the question with its show, then files it with Make', async () => {
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: QUESTION }), res)

    expect(res.statusCode).toBe(200)
    expect(calls.map((c) => c.url === WEBHOOK_URL)).toEqual([false, true])

    const email = JSON.parse(String(calls[0].init?.body)) as { subject: string; html: string }
    expect(email.subject).toBe('[Contact — Listener questions — Chosen People Problems] Jane Listener')
    expect(email.html).toContain('<strong>Show:</strong> Chosen People Problems')

    const hook = calls[1].init!
    expect((hook.headers as Record<string, string>)['x-make-apikey']).toBe('make-key')
    const payload = JSON.parse(String(hook.body)) as Record<string, string>
    expect(payload).toMatchObject({
      firstName: 'Jane',
      lastName: 'Listener',
      email: 'jane@example.com',
      location: '',
      topic: 'Listener questions',
      topicSlug: 'questions',
      show: 'Chosen People Problems',
      showSlug: 'chosen-people-problems',
      message: 'What is the best Shabbat dinner argument?',
    })
    expect(Number.isNaN(Date.parse(payload.submittedAt))).toBe(false)
  })

  test('requires both name parts, and caps each', async () => {
    for (const body of [
      { ...QUESTION, firstName: ' ' },
      { ...QUESTION, lastName: '' },
      { ...QUESTION, lastName: undefined },
      { ...QUESTION, firstName: 'N'.repeat(201) },
    ]) {
      const res = makeRes()
      await getHandler(ENV)(makeReq({ body }), res)
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('invalid_name')
    }
    expect(fetchCalls).toBe(0)
  })

  test('passes an optional location to the email and Make, and caps it', async () => {
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: { ...QUESTION, location: '  Tel Aviv, <Israel> ' } }), res)
    expect(res.statusCode).toBe(200)
    const email = JSON.parse(String(calls[0].init?.body)) as { html: string }
    expect(email.html).toContain('<strong>Location:</strong> Tel Aviv, &lt;Israel&gt;')
    const payload = JSON.parse(String(calls[1].init?.body)) as Record<string, string>
    expect(payload.location).toBe('Tel Aviv, <Israel>')

    const tooLong = makeRes()
    await getHandler(ENV)(makeReq({ body: { ...QUESTION, location: 'x'.repeat(201) } }), tooLong)
    expect(tooLong.statusCode).toBe(400)
    expect(JSON.parse(tooLong.body).error).toBe('invalid_location')
  })

  test('leaves the Location line out of the email when none was given', async () => {
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: QUESTION }), res)
    const email = JSON.parse(String(calls[0].init?.body)) as { html: string }
    expect(email.html).not.toContain('Location:')
  })

  test('accepts every show, free and Ark+', async () => {
    for (const show of shows) {
      const res = makeRes()
      await getHandler(ENV)(makeReq({ body: { ...QUESTION, show: show.slug } }), res)
      expect(res.statusCode).toBe(200)
    }
  })

  test('sends an Ark+ show under its display name and stable slug', async () => {
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: { ...QUESTION, show: 'call-me-back-plus' } }), res)
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(String(calls[1].init?.body)) as Record<string, string>
    expect(payload.show).toBe('Call Me Back | Ark+')
    expect(payload.showSlug).toBe('call-me-back-plus')
  })

  test('rejects a question with no show, or a show not on the list', async () => {
    for (const show of [undefined, '', 'whats-your-number', 'nonsense']) {
      const res = makeRes()
      await getHandler(ENV)(makeReq({ body: { ...QUESTION, show } }), res)
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('invalid_show')
    }
    expect(fetchCalls).toBe(0)
  })

  test('files every other topic too, with no show even if one was sent', async () => {
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: { ...VALID, show: 'chosen-people-problems' } }), res)
    expect(res.statusCode).toBe(200)
    expect(calls.map((c) => c.url === WEBHOOK_URL)).toEqual([false, true])
    const email = JSON.parse(String(calls[0].init?.body)) as { html: string }
    expect(email.html).not.toContain('Show:')
    const payload = JSON.parse(String(calls[1].init?.body)) as Record<string, string>
    expect(payload).toMatchObject({
      topic: 'Press, interviews & media',
      topicSlug: 'press',
      show: '',
      showSlug: '',
      message: VALID.message,
    })
  })

  test('does not file the question when the email fails', async () => {
    resendStatus = 500
    const res = makeRes()
    await getHandler(ENV)(makeReq({ body: QUESTION }), res)
    expect(res.statusCode).toBe(502)
    expect(calls.map((c) => c.url)).not.toContain(WEBHOOK_URL)
  })

  test('a Make failure or outage does not fail the submission', async () => {
    webhookStatus = 500
    const refused = makeRes()
    await getHandler(ENV)(makeReq({ body: QUESTION }), refused)
    expect(refused.statusCode).toBe(200)

    webhookThrows = true
    const down = makeRes()
    await getHandler(ENV)(makeReq({ body: QUESTION }), down)
    expect(down.statusCode).toBe(200)
  })

  test('still emails when no webhook is configured', async () => {
    const res = makeRes()
    await getHandler({ RESEND_API_KEY: 'test' })(makeReq({ body: QUESTION }), res)
    expect(res.statusCode).toBe(200)
    expect(fetchCalls).toBe(1)
  })
})
