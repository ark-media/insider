# Supporting Cast feed redirect

Members who set up the old Supporting Cast private feed hold a personalised
URL in their podcast app:

    https://inside.arkmedia.org/content/<token>.rss

`inside.arkmedia.org` is our DNS, currently a CNAME to Supporting Cast's CDN.
When SC is switched off, that hostname moves to Vercel and each old URL answers
with a permanent redirect to the member's Beehiiv feed:

    301 Location: https://rss.beehiiv.com/podcasts/<show>/private/<tok>.xml

Apps that honour a 301 rewrite the stored URL; the rest follow it on every
refresh. The redirect therefore stays up for good.

## Pieces

| What | Where |
| --- | --- |
| Token decoder (`u` = SC user id) | `shared/sc-feed-token.ts` |
| Roster export from the SC API | `scripts/export-sc-feeds.ts` → `.tmp/sc-feeds-<date>.csv` |
| Roster load into Neon | `scripts/import-sc-feeds.ts --file <csv>` → `sc_feed_members` (migration 0011) |
| Coverage dry run against Beehiiv | `scripts/sc-feed-coverage.ts [--limit N]` → `.tmp/sc-feed-coverage-<date>.csv` |
| The redirect | `server/routes/sc-feed-redirect.ts`, reached via the `vercel.json` rewrite `/content/:token.rss` |
| Target show | env `SC_FEED_REDIRECT_SHOW_ID` (a `pod_…` id; the Beehiiv show the one SC feed maps to) |

The route resolves the Beehiiv feed per request (the Beehiiv token rotates on
reissue) and caches the 301 at the edge for an hour. A member with no feed on
the target show — lapsed, or not minted yet — gets a small valid RSS feed that
says the feed has moved and links to `/account/podcast-feed`. Database or
Beehiiv trouble is a 503 with `Retry-After`, never a stub or a redirect an app
would remember.

## Before cutover

1. `SC_FEED_REDIRECT_SHOW_ID` set in Vercel (Production, and Preview if
   testing there) to the premium show the old "Inside Call Me Back" feed maps
   to. The coverage script aborts if the id is a public show.
2. Roster loaded into the **production** database:
   `DATABASE_URL=<prod pooled url> bun run scripts/import-sc-feeds.ts --file .tmp/sc-feeds-<date>.csv`.
   Re-run the export first if SC has been live for a while since the last one.
3. Coverage run green: `bun run scripts/sc-feed-coverage.ts` against the prod
   database. "entitled, no feed on show" must be 0; "not entitled, SC active"
   is the count of members not yet migrated to Beehiiv premium.
4. Redirect tested on the preview URL with a real token:
   `curl -I https://<preview>.vercel.app/content/<token>.rss` → 301 to
   `rss.beehiiv.com`. Then subscribe a podcast app to that preview URL.
5. The `inside` CNAME TTL lowered to 60s a day or two ahead.

## Cutover

1. Add `inside.arkmedia.org` to the Vercel project (Domains). Vercel issues the
   certificate once DNS points at it.
2. Change the `inside` CNAME from Supporting Cast's host to `cname.vercel-dns.com`.
3. `curl -I https://inside.arkmedia.org/content/<token>.rss` → 301.
4. Watch the function logs for `[sc-feed-redirect]` warnings (members landing
   on the stub) for the first days.

Rollback is the CNAME pointed back at Supporting Cast. SC keeps serving the
feeds until the account is closed, so do not close it until the redirect has
run clean for a while.

## Not covered

- URLs on `*.supportingcast.fm` rather than our hostname. Ask SC support to
  redirect those on their side.
- Spotify. Spotify members are linked by OAuth, not by URL.
- The stub feed carries no audio enclosure, so Apple Podcasts shows the
  channel but lists no episode; other apps show the notice item.
