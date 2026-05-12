// Whoami / personalized feeds. Returns the signed-in user's SC feeds so
// the SPA can render the setup page (and decide whether to surface a "send
// SMS" button).

import { makeJsonRes } from '../lib/http.js'
import { getSessionEmail } from '../lib/session.js'
import {
  createScClient,
  findScUserByEmail,
  type ScError,
  type ScUserFeed,
} from '../lib/sc-client.js'
import type { Deps, Route } from '../lib/route.js'

export function meRoutes({ env }: Deps): Route[] {
  return [
    {
      path: '/api/me',
      handler: async (req, res) => {
        const json = makeJsonRes(res)
        const email = await getSessionEmail(req, env)
        if (!email) return json(401, { error: 'unauthenticated' })

        try {
          const sc = createScClient(env)
          const user = await findScUserByEmail(sc, email)
          if (!user) return json(401, { error: 'membership_not_found' })
          let feeds: ScUserFeed[] = []
          try {
            const feedsRes = await sc.call<{ feeds: ScUserFeed[] }>(
              'GET',
              `/users/${user.id}/feeds`,
            )
            feeds = feedsRes.feeds ?? []
          } catch (feedErr) {
            if ((feedErr as ScError).status !== 404) throw feedErr
            // 404 means no feeds set up yet — treat as empty.
          }
          json(200, { email, feeds })
        } catch (err) {
          console.error('[me] sc lookup failed:', err)
          const status = (err as ScError).status ?? 502
          json(status, { error: 'membership_lookup_failed' })
        }
      },
    },
  ]
}
