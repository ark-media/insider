// The permanent redirect from a member's old Supporting Cast feed URL to their
// Beehiiv feed.
//
//   GET https://inside.arkmedia.org/content/<token>.rss
//     → vercel.json rewrites to /api/sc-feed-redirect?token=<token>
//     → 301 Location: https://rss.beehiiv.com/podcasts/<show>/private/<tok>.xml
//
// Why a redirect at all: podcast apps hold the old URL. Once SC is gone the
// only way those apps keep working is for the old hostname — ours — to answer.
// Apple Podcasts, Overcast and Pocket Casts rewrite the stored URL on a 301;
// others follow it on every refresh. Either way this route stays up for good.
//
// How the member is found: the token carries SC's user id (shared/sc-feed-
// token.ts); sc_feed_members (the one-time SC export) turns it into an email;
// Beehiiv is asked for that email's feed on the ONE show the old feed maps to
// (SC_FEED_REDIRECT_SHOW_ID). Resolved per request, not stored, because the
// Beehiiv feed token rotates on reissue.
//
// What a member without a feed gets: a small valid RSS feed that says the feed
// has moved and where to get the new one, not an error. An app shows the
// text; a 404 shows a broken feed with no explanation. That covers a lapsed
// member (no Beehiiv premium, no feed), a member whose Beehiiv feed is not
// minted yet (Beehiiv mints asynchronously), and an SC user id we never
// exported. Only an input that is not an SC token at all is a 404.
//
// Failures are 503 with Retry-After: an app that gets a 503 keeps the URL and
// tries again later, which is exactly right while the database or Beehiiv is
// having a moment. A 301 to nowhere or a stub served over a blip would be
// remembered by the app.

import type { Deps, Route } from '../lib/route.js'
import { defineRoute } from '../lib/route.js'
import { getDb } from '../lib/db.js'
import { fetchPrivateFeedForShow } from '../lib/beehiiv-feeds.js'
import { decodeScFeedToken } from '../../shared/sc-feed-token.js'
import { redactEmail } from '../../shared/validation.js'

export const SC_FEED_REDIRECT_PATH = '/api/sc-feed-redirect'

// A redirect is cached at the edge for an hour: apps that never rewrite the
// URL refresh roughly hourly, and the rotation window this leaves (a reissued
// Beehiiv token is unreachable through the OLD url for at most an hour) is
// shorter than any app's own retry schedule. The stub is cached for a minute
// only — a freshly minted feed should replace it on the next refresh.
const REDIRECT_CACHE_SEC = 3600
const STUB_CACHE_SEC = 60

type ScMemberRow = { email: string; sc_status: string }

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Fixed, not `now()`: a changing pubDate would make apps announce the same
// notice as a new episode on every refresh.
const STUB_PUB_DATE = 'Thu, 01 Oct 2026 00:00:00 GMT'

export function feedMovedRss(appBaseUrl: string): string {
  const setupUrl = xmlEscape(`${appBaseUrl}/account/podcast-feed`)
  const joinUrl = xmlEscape(`${appBaseUrl}/subscribe`)
  const title = 'This feed has moved'
  const description =
    `Your Ark+ podcast feed now lives at a new address. ` +
    `Sign in at ${setupUrl} to add the new feed to this app — it takes a minute. ` +
    `If your membership has ended, you can rejoin at ${joinUrl}.`
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">\n` +
    `<channel>\n` +
    `<title>${title}</title>\n` +
    `<link>${setupUrl}</link>\n` +
    `<description>${description}</description>\n` +
    `<language>en-us</language>\n` +
    `<itunes:block>Yes</itunes:block>\n` +
    `<item>\n` +
    `<title>${title}: how to get the new one</title>\n` +
    `<link>${setupUrl}</link>\n` +
    `<guid isPermaLink="false">ark-plus-feed-moved-2026-10</guid>\n` +
    `<pubDate>${STUB_PUB_DATE}</pubDate>\n` +
    `<description>${description}</description>\n` +
    `</item>\n` +
    `</channel>\n` +
    `</rss>\n`
  )
}

export function scFeedRedirectRoutes({ env, appBaseUrl }: Deps): Route[] {
  return [
    defineRoute({
      path: SC_FEED_REDIRECT_PATH,
      method: ['GET', 'HEAD'],
      handler: async (req, res, json) => {
        const url = new URL(req.url ?? '', 'http://x')
        const token = decodeScFeedToken(url.searchParams.get('token') ?? '')
        if (!token) return json(404, { error: 'not_found' })

        const sendStub = () => {
          res.statusCode = 200
          res.setHeader('content-type', 'application/rss+xml; charset=utf-8')
          res.setHeader(
            'cache-control',
            `public, s-maxage=${STUB_CACHE_SEC}, max-age=${STUB_CACHE_SEC}`,
          )
          res.end(req.method === 'HEAD' ? undefined : feedMovedRss(appBaseUrl))
        }
        const sendUnavailable = () => {
          res.setHeader('retry-after', '300')
          res.setHeader('cache-control', 'no-store')
          json(503, { error: 'temporarily_unavailable' })
        }

        const showId = env.SC_FEED_REDIRECT_SHOW_ID
        if (!showId || !env.DATABASE_URL) {
          console.error('[sc-feed-redirect] SC_FEED_REDIRECT_SHOW_ID or DATABASE_URL unset')
          return sendUnavailable()
        }

        let member: ScMemberRow | undefined
        try {
          const rows = (await getDb(env)`
            select email, sc_status from sc_feed_members
            where sc_user_id = ${token.userId}::bigint
          `) as ScMemberRow[]
          member = rows[0]
        } catch (err) {
          console.error('[sc-feed-redirect] lookup failed:', err)
          return sendUnavailable()
        }
        if (!member) return sendStub()

        const feed = await fetchPrivateFeedForShow(env, member.email, showId)
        if (feed === 'error') return sendUnavailable()
        if (!feed) {
          console.warn(
            `[sc-feed-redirect] no Beehiiv feed for ${redactEmail(member.email)} (sc ${member.sc_status})`,
          )
          return sendStub()
        }

        res.statusCode = 301
        res.setHeader('location', feed.url)
        res.setHeader(
          'cache-control',
          `public, s-maxage=${REDIRECT_CACHE_SEC}, max-age=${REDIRECT_CACHE_SEC}`,
        )
        res.end()
      },
    }),
  ]
}
