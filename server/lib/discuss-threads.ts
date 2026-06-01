// Discuss threads: per-article Circle threads paired with a Beehiiv post.
//
// Two surfaces share this module:
//   1. The /admin back office calls `createCompanionThread` to mint the Circle
//      thread, patch the Beehiiv draft body, and persist the mapping row.
//   2. The public /api/beehiiv/posts route calls `listDiscussThreadsByNewsletter`
//      to enrich projected NewsletterPosts with their per-article `discussUrl`.
//
// Schema lives in `migrations/` — run `bun run migrate` to apply.

import type { Sql } from './db.js'
import type { DiscussThread, BeehiivDraft } from '../../shared/discuss-thread.js'
import type { NewsletterSlug } from '../../src/data/newsletters.js'
import { isNewsletterSlug } from '../routes/newsletter-slugs.js'

// newsletter slug → Circle space slug the companion thread lives in. The
// read-side bindings in `server/routes/circle.ts` only cover `members-letter`
// today; write-side bindings stay separate so we can target whichever space
// hosts public-facing discussion threads per newsletter without coupling the
// two paths. Space slugs map to space IDs via Circle's /spaces endpoint.
const DISCUSS_SPACE_BINDINGS: Record<NewsletterSlug, string> = {
  'ark-daily': 'ark-daily',
  'members-letter': 'inside-call-me-back',
}

export function discussSpaceSlugFor(slug: NewsletterSlug): string {
  return DISCUSS_SPACE_BINDINGS[slug]
}

// --- DB accessors --------------------------------------------------------

type Row = Record<string, unknown>

function mapRow(r: Row): DiscussThread {
  // The Neon driver returns timestamptz as a Date today, but accept either
  // shape so a driver upgrade can't crash mapRow on the cast.
  const createdAtRaw = r.created_at
  const createdAt =
    createdAtRaw instanceof Date
      ? createdAtRaw
      : new Date(String(createdAtRaw))
  return {
    id: String(r.id),
    newsletterSlug: String(r.newsletter_slug) as NewsletterSlug,
    beehiivPostId: String(r.beehiiv_post_id),
    beehiivPostTitle: String(r.beehiiv_post_title),
    circleThreadUrl: String(r.circle_thread_url),
    circleSpaceId: Number(r.circle_space_id),
    circlePostId: String(r.circle_post_id),
    beehiivBodyPatched: Boolean(r.beehiiv_body_patched),
    createdAt: createdAt.toISOString(),
  }
}

export async function listDiscussThreads(sql: Sql): Promise<DiscussThread[]> {
  const rows = (await sql`
    select id, newsletter_slug, beehiiv_post_id, beehiiv_post_title,
           circle_thread_url, circle_space_id, circle_post_id,
           beehiiv_body_patched, created_at
    from discuss_threads
    order by created_at desc
  `) as Row[]
  return rows.map(mapRow)
}

export async function listDiscussThreadsByNewsletter(
  sql: Sql,
  newsletterSlug: NewsletterSlug,
): Promise<DiscussThread[]> {
  const rows = (await sql`
    select id, newsletter_slug, beehiiv_post_id, beehiiv_post_title,
           circle_thread_url, circle_space_id, circle_post_id,
           beehiiv_body_patched, created_at
    from discuss_threads
    where newsletter_slug = ${newsletterSlug}
    order by created_at desc
  `) as Row[]
  return rows.map(mapRow)
}

export async function getDiscussThreadByBeehiivId(
  sql: Sql,
  beehiivPostId: string,
): Promise<DiscussThread | null> {
  const rows = (await sql`
    select id, newsletter_slug, beehiiv_post_id, beehiiv_post_title,
           circle_thread_url, circle_space_id, circle_post_id,
           beehiiv_body_patched, created_at
    from discuss_threads
    where beehiiv_post_id = ${beehiivPostId}
    limit 1
  `) as Row[]
  return rows[0] ? mapRow(rows[0]) : null
}

type InsertInput = Omit<DiscussThread, 'id' | 'createdAt'>

async function insertDiscussThread(
  sql: Sql,
  input: InsertInput,
): Promise<DiscussThread> {
  const rows = (await sql`
    insert into discuss_threads
      (newsletter_slug, beehiiv_post_id, beehiiv_post_title,
       circle_thread_url, circle_space_id, circle_post_id, beehiiv_body_patched)
    values
      (${input.newsletterSlug}, ${input.beehiivPostId}, ${input.beehiivPostTitle},
       ${input.circleThreadUrl}, ${input.circleSpaceId}, ${input.circlePostId},
       ${input.beehiivBodyPatched})
    returning id, newsletter_slug, beehiiv_post_id, beehiiv_post_title,
              circle_thread_url, circle_space_id, circle_post_id,
              beehiiv_body_patched, created_at
  `) as Row[]
  return mapRow(rows[0])
}

export async function deleteDiscussThread(sql: Sql, id: string): Promise<boolean> {
  const rows = (await sql`delete from discuss_threads where id = ${id} returning id`) as Row[]
  return rows.length > 0
}

// --- Validation ----------------------------------------------------------

export type CreateThreadInput = {
  newsletterSlug: NewsletterSlug
  beehiivPostId: string
  beehiivPostTitle: string
  /** Optional canonical URL to the article on the Ark Media site. */
  canonicalUrl?: string
}

export type ValidationResult =
  | { ok: true; value: CreateThreadInput }
  | { ok: false; error: string }

const BEEHIIV_POST_ID = /^post_[A-Za-z0-9-]+$/

export function validateCreateThreadInput(raw: unknown): ValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.newsletterSlug !== 'string' || !isNewsletterSlug(r.newsletterSlug)) {
    return { ok: false, error: 'newsletterSlug is required.' }
  }
  if (typeof r.beehiivPostId !== 'string' || !BEEHIIV_POST_ID.test(r.beehiivPostId)) {
    return { ok: false, error: 'beehiivPostId is required and must look like post_<id>.' }
  }
  if (typeof r.beehiivPostTitle !== 'string' || !r.beehiivPostTitle.trim()) {
    return { ok: false, error: 'beehiivPostTitle is required.' }
  }
  let canonicalUrl: string | undefined
  if (r.canonicalUrl != null && r.canonicalUrl !== '') {
    if (typeof r.canonicalUrl !== 'string') {
      return { ok: false, error: 'canonicalUrl must be a string.' }
    }
    try {
      const u = new URL(r.canonicalUrl)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { ok: false, error: 'canonicalUrl must be http(s).' }
      }
      canonicalUrl = r.canonicalUrl
    } catch {
      return { ok: false, error: 'canonicalUrl is not a valid URL.' }
    }
  }
  return {
    ok: true,
    value: {
      newsletterSlug: r.newsletterSlug,
      beehiivPostId: r.beehiivPostId,
      beehiivPostTitle: r.beehiivPostTitle.trim(),
      canonicalUrl,
    },
  }
}

// --- Circle Admin v2 — create space post ---------------------------------

type CircleSpaceRecord = { id?: number; slug?: string }

// Short-lived in-memory cache so a burst of admin actions doesn't re-page
// the entire spaces list. 60s is well under any meaningful "we renamed the
// space" turnaround, and a stale miss surfaces as a clean "space not found"
// rather than corrupting state.
const SPACE_ID_CACHE = new Map<string, { id: number; at: number }>()
const SPACE_ID_TTL_MS = 60_000

async function resolveCircleSpaceId(
  spaceSlug: string,
  token: string,
): Promise<number | null> {
  const cached = SPACE_ID_CACHE.get(spaceSlug)
  if (cached && Date.now() - cached.at < SPACE_ID_TTL_MS) return cached.id

  // Same paging shape as the read-side resolver in routes/circle.ts. We
  // keep the cache here local rather than sharing read/write paths so a
  // stale entry in one surface can't break the other.
  for (let page = 1; page <= 5; page += 1) {
    const url =
      `https://app.circle.so/api/admin/v2/spaces` +
      `?per_page=100&page=${page}`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`Circle spaces ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { records?: CircleSpaceRecord[] }
    const records = body.records ?? []
    if (records.length === 0) break
    const match = records.find((s) => s.slug === spaceSlug)
    if (match?.id !== undefined) {
      SPACE_ID_CACHE.set(spaceSlug, { id: match.id, at: Date.now() })
      return match.id
    }
    if (records.length < 100) break
  }
  return null
}

// Build the Tiptap doc Circle's rich-text editor expects. Two short paragraphs:
// a one-line intro and a link out to the canonical article. Discussion lives in
// the comments below, not in the post body.
function buildThreadTiptapDoc(opts: {
  intro: string
  linkText: string
  linkHref: string
}): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: opts.intro }],
      },
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: opts.linkText,
            marks: [{ type: 'link', attrs: { href: opts.linkHref, target: '_blank' } }],
          },
        ],
      },
    ],
  }
}

type CircleCreatePostResult = {
  spaceId: number
  postId: string
  threadUrl: string
}

async function createCircleSpacePost(opts: {
  token: string
  communityHost: string
  spaceSlug: string
  spaceId: number
  title: string
  bodyDoc: Record<string, unknown>
}): Promise<CircleCreatePostResult> {
  // Circle Admin v2 POST /posts. We use tiptap_body for the body — Circle's
  // create endpoints accept both `body` (string/HTML) and `tiptap_body` (doc),
  // and the doc form survives Circle's editor round-trip more cleanly.
  const res = await fetch('https://app.circle.so/api/admin/v2/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      space_id: opts.spaceId,
      name: opts.title,
      post_type: 'basic',
      tiptap_body: opts.bodyDoc,
      published_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) {
    throw new Error(`Circle create post ${res.status}: ${await res.text()}`)
  }
  // Circle Admin v2 wraps the created record under `post`:
  //   { message: "Post created.", post: { id, slug, ... } }
  const body = (await res.json()) as {
    post?: { id?: number | string; slug?: string }
  }
  const created = body.post ?? {}
  if (created.id === undefined || created.id === null) {
    throw new Error(
      `Circle create post: response missing post.id — got ${JSON.stringify(body).slice(0, 500)}`,
    )
  }
  const postId = String(created.id)
  // The thread URL follows /c/<space-slug>/<post-slug-or-id> — Circle does
  // not include a /posts/ intermediate segment.
  const segment = created.slug && created.slug.trim() ? created.slug : postId
  const threadUrl = `${opts.communityHost}/c/${opts.spaceSlug}/${segment}`
  return { spaceId: opts.spaceId, postId, threadUrl }
}

// --- Beehiiv Admin v2 — list drafts + patch draft body -------------------

export async function listBeehiivDrafts(opts: {
  token: string
  publicationId: string
}): Promise<BeehiivDraft[]> {
  if (!/^pub_[A-Za-z0-9-]+$/.test(opts.publicationId)) return []
  const url =
    `https://api.beehiiv.com/v2/publications/${opts.publicationId}/posts` +
    `?status=draft&limit=50`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`Beehiiv drafts ${res.status}: ${await res.text()}`)
  }
  const body = (await res.json()) as {
    data?: Array<{ id?: string; title?: string; slug?: string; audience?: string }>
  }
  return (body.data ?? [])
    .filter((p): p is { id: string } & typeof p => typeof p.id === 'string')
    .map((p) => {
      const a = (p.audience ?? 'unknown').toLowerCase()
      const audience: BeehiivDraft['audience'] =
        a === 'free' || a === 'premium' || a === 'both' ? a : 'unknown'
      return {
        id: p.id,
        title: p.title ?? '(untitled)',
        slug: p.slug ?? null,
        audience,
      }
    })
}

const DISCUSS_LINK_MARKER = '<!-- ark:discuss-link -->'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildDiscussLinkHtml(threadUrl: string): string {
  // Single-paragraph CTA appended to the Beehiiv draft body. The marker comment
  // around it lets a future edit recognize and replace its own insertion,
  // rather than stacking links if the editor re-runs the action.
  //
  // threadUrl comes from Circle's create-post response and is spliced into
  // both an href attribute and the link text. HTML-escape it before
  // interpolating so a slug containing `"` or `<` can't break out of either
  // context — Beehiiv does not re-sanitize what we PUT into its draft body.
  const safe = escapeHtml(threadUrl)
  return (
    `${DISCUSS_LINK_MARKER}` +
    `<p>` +
    `<strong>Discuss this piece →</strong> ` +
    `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>` +
    `</p>` +
    `${DISCUSS_LINK_MARKER}`
  )
}

function spliceDiscussLink(existingHtml: string, threadUrl: string): string {
  const block = buildDiscussLinkHtml(threadUrl)
  // If the editor already ran "create thread" before, the markers are present.
  // Replace what's between them so we don't accumulate stacked CTAs.
  const re = new RegExp(
    `${DISCUSS_LINK_MARKER}[\\s\\S]*?${DISCUSS_LINK_MARKER}`,
    'i',
  )
  if (re.test(existingHtml)) return existingHtml.replace(re, block)
  return `${existingHtml}\n${block}`
}

async function patchBeehiivDraftBody(opts: {
  token: string
  publicationId: string
  beehiivPostId: string
  threadUrl: string
}): Promise<boolean> {
  // Beehiiv update flow:
  //   GET /v2/publications/{pubId}/posts/{postId}?expand[]=free_web_content
  //     → existing HTML at data.content.free.web
  //   PATCH /v2/publications/{pubId}/posts/{postId}
  //     body: { body_content: <html> } — wraps the HTML in an htmlSnippet block,
  //     replacing the post's current content. PUT 404s on this route.
  // Any non-2xx is treated as "Beehiiv refused our update"; we don't fail the
  // whole orchestration, the admin gets a flag back to paste manually.
  const get = await fetch(
    `https://api.beehiiv.com/v2/publications/${opts.publicationId}/posts/${opts.beehiivPostId}?expand[]=free_web_content`,
    { headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' } },
  )
  if (!get.ok) {
    console.error(
      `[discuss-threads] beehiiv GET ${get.status}: ${(await get.text()).slice(0, 500)}`,
    )
    return false
  }
  const fetched = (await get.json()) as {
    data?: { content?: { free?: { web?: string } } }
  }
  const existing = fetched.data?.content?.free?.web ?? ''
  const next = spliceDiscussLink(existing, opts.threadUrl)
  const patch = await fetch(
    `https://api.beehiiv.com/v2/publications/${opts.publicationId}/posts/${opts.beehiivPostId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body_content: next }),
    },
  )
  if (!patch.ok) {
    console.error(
      `[discuss-threads] beehiiv PATCH ${patch.status}: ${(await patch.text()).slice(0, 500)}`,
    )
  }
  return patch.ok
}

// --- Orchestration -------------------------------------------------------

export type OrchestrationDeps = {
  circleToken: string
  beehiivToken: string
  beehiivPublicationId: string
  communityHost: string
  /** Base URL for the public Ark Media site — used as the canonical link in the
   *  Circle thread body when the caller didn't supply a `canonicalUrl`. */
  appBaseUrl: string
}

export type CreateCompanionThreadResult =
  | { ok: true; thread: DiscussThread; alreadyExisted: boolean }
  | { ok: false; status: number; error: string }

export async function createCompanionThread(
  sql: Sql,
  input: CreateThreadInput,
  deps: OrchestrationDeps,
): Promise<CreateCompanionThreadResult> {
  // Idempotency: if a row already exists for this Beehiiv post id, return it.
  // Stops a double-click from minting a second Circle thread.
  const existing = await getDiscussThreadByBeehiivId(sql, input.beehiivPostId)
  if (existing) return { ok: true, thread: existing, alreadyExisted: true }

  const spaceSlug = discussSpaceSlugFor(input.newsletterSlug)
  const spaceId = await resolveCircleSpaceId(spaceSlug, deps.circleToken)
  if (spaceId === null) {
    return {
      ok: false,
      status: 502,
      error: `Could not find Circle space "${spaceSlug}". Check the binding in discuss-threads.ts.`,
    }
  }

  const canonical =
    input.canonicalUrl ??
    `${deps.appBaseUrl.replace(/\/$/, '')}/newsletters`
  const bodyDoc = buildThreadTiptapDoc({
    intro: `Discussion for "${input.beehiivPostTitle}". Reactions, pushback, and follow-up questions welcome — the Ark team checks in throughout the week.`,
    linkText: 'Read the full piece on Ark Media →',
    linkHref: canonical,
  })

  let created: CircleCreatePostResult
  try {
    created = await createCircleSpacePost({
      token: deps.circleToken,
      communityHost: deps.communityHost,
      spaceSlug,
      spaceId,
      title: input.beehiivPostTitle,
      bodyDoc,
    })
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Circle create failed',
    }
  }

  let bodyPatched = false
  try {
    bodyPatched = await patchBeehiivDraftBody({
      token: deps.beehiivToken,
      publicationId: deps.beehiivPublicationId,
      beehiivPostId: input.beehiivPostId,
      threadUrl: created.threadUrl,
    })
  } catch (err) {
    // Beehiiv refused or threw — Circle thread is already live. We keep going,
    // record the row with `beehiivBodyPatched: false`, and the admin sees the
    // "copy URL manually" hint.
    console.error('[discuss-threads] beehiiv body patch failed:', err)
  }

  const thread = await insertDiscussThread(sql, {
    newsletterSlug: input.newsletterSlug,
    beehiivPostId: input.beehiivPostId,
    beehiivPostTitle: input.beehiivPostTitle,
    circleThreadUrl: created.threadUrl,
    circleSpaceId: created.spaceId,
    circlePostId: created.postId,
    beehiivBodyPatched: bodyPatched,
  })
  return { ok: true, thread, alreadyExisted: false }
}

// Exposed for tests so they can target the splice without hitting the network.
export const __testing = {
  buildDiscussLinkHtml,
  spliceDiscussLink,
  DISCUSS_LINK_MARKER,
}
