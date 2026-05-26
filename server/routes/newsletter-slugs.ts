// Newsletter slug guard. Imported by every route that takes a newsletter
// slug as a query param, so the slug is validated against a closed set
// before it's used to derive env keys or upstream URLs.

import type { NewsletterSlug } from '../../src/data/newsletters.js'

const NEWSLETTER_SLUGS = new Set<NewsletterSlug>([
  'ark-daily',
  'members-letter',
])

export function isNewsletterSlug(s: string): s is NewsletterSlug {
  return (NEWSLETTER_SLUGS as Set<string>).has(s)
}
