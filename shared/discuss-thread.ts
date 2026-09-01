// API shape for a discuss-thread mapping. One row per Beehiiv post that has
// a companion Circle thread. The Beehiiv post id is the natural key — the
// thread is the conversation venue, the post is the article.

import type { NewsletterSlug } from '../src/data/newsletters.js'

export type DiscussThread = {
  id: string
  newsletterSlug: NewsletterSlug
  beehiivPostId: string
  beehiivPostTitle: string
  circleThreadUrl: string
  circleSpaceId: number
  circlePostId: string
  /**
   * True when the orchestrator successfully patched the Beehiiv draft body to
   * include a link back to the Circle thread. False means the Circle thread
   * exists and the row is persisted, but the editor needs to paste the URL
   * into the Beehiiv draft by hand before publishing.
   */
  beehiivBodyPatched: boolean
  createdAt: string
}

// What an editor lists when picking a Beehiiv post to attach a thread to.
// Drafts only — confirmed posts can't have their body updated reliably, so
// the workflow is "create thread before publishing".
export type BeehiivDraft = {
  id: string
  title: string
  slug: string | null
  audience: 'free' | 'premium' | 'both' | 'unknown'
}
