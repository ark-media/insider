// Newsletter slug guard. Imported by every route that takes a newsletter
// slug as a query param, so the slug is validated against a closed set
// before it's used to derive env keys or upstream URLs.

import type { NewsletterSlug } from '../../src/data/newsletters.js'
import type { Env } from '../lib/route.js'

const NEWSLETTER_SLUGS = new Set<NewsletterSlug>([
  'ark-daily',
  'members-letter',
])

export function isNewsletterSlug(s: string): s is NewsletterSlug {
  return (NEWSLETTER_SLUGS as Set<string>).has(s)
}

// The Beehiiv publication env key for a newsletter slug, e.g.
// `BEEHIIV_PUBLICATION_ID_ARK_DAILY`. The slug is from the closed NewsletterSlug
// union, so the derived key can't be attacker-controlled.
export function beehiivPublicationEnvKey(slug: NewsletterSlug): string {
  return `BEEHIIV_PUBLICATION_ID_${slug.toUpperCase().replace(/-/g, '_')}`
}

// Resolve the Beehiiv publication id for a newsletter slug from env, or
// undefined when unset/blank. Shared by the beehiiv posts route and the
// discuss-thread admin routes.
export function resolveBeehiivPublicationId(
  env: Env,
  slug: NewsletterSlug,
): string | undefined {
  const value = env[beehiivPublicationEnvKey(slug)]
  return value && value.trim() ? value.trim() : undefined
}
