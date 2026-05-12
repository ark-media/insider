// Newsletter source abstraction.
//
// Each newsletter slug is bound to exactly one source (Beehiiv or Circle).
// While we evaluate the two providers we want page code to be source-agnostic:
// pages call `sourceFor(slug).listPosts(...)` and don't know or care which
// backend answers. Flipping a newsletter between providers is a one-line edit
// to `sourceBySlug` below.
//
// Subscription / email-list management is intentionally NOT part of this
// surface — that lives on the Beehiiv module and stays there during the test.

import type { NewsletterPost, NewsletterSlug } from "../data/newsletters";
import { beehiivSource } from "./beehiiv";
import { circleSource, circleSpaceSource } from "./circle";

export type FetchPostResult =
  | { kind: "ok"; post: NewsletterPost }
  | { kind: "gated"; preview: NewsletterPost; reason: "ark-plus-required" }
  | { kind: "not-found" };

export interface NewsletterSource {
  listPosts(slug: NewsletterSlug): Promise<NewsletterPost[]>;
  getPost(
    slug: NewsletterSlug,
    postSlug: string,
    isMember: boolean,
  ): Promise<FetchPostResult>;
}

const sourceBySlug: Record<NewsletterSlug, NewsletterSource> = {
  "the-call-me-back-newsletter": circleSource,
  "ark-daily": beehiivSource,
  "for-heavens-sake-newsletter": beehiivSource,
  "members-letter": circleSpaceSource,
};

export function sourceFor(slug: NewsletterSlug): NewsletterSource {
  return sourceBySlug[slug];
}
