import type { ShowSlug } from "./shows";

/**
 * The Israel Votes curation.
 *
 * Editorial data only: WHICH episodes belong on the page, in what order, and
 * which YouTube cut pairs with them. No episode data — no audio urls, no
 * dates, no durations. Those are fetched from the podcast host at runtime
 * (`fetchEpisodeById`), the same as everywhere else on the site.
 *
 * This page used to embed `cdn.simplecast.com` mp3 links directly, which meant
 * the whole page silently went dead the moment the shows moved hosts. An
 * episode is referenced here by its Beehiiv id — the host's own stable handle
 * for it, unaffected by renames — and nothing else.
 *
 * `title` is deliberately still ours: these are shortened for the page (the
 * upstream titles carry an "ISRAEL VOTES:" prefix and a full guest list that
 * doesn't fit a playlist row). Everything that can go stale comes from Beehiiv.
 */
export type CuratedEpisode = {
  show: ShowSlug;
  /** Beehiiv episode id (`pod_ep_…`). Stable across title edits. */
  episodeId: string;
  /** Display title for this page. */
  title: string;
};

export type Explainer = CuratedEpisode & {
  /** YouTube id for the video cut of this conversation. */
  videoId: string;
  /** Attribution line above the title. Defaults to the show's short title. */
  credit?: string;
};

export const EXPLAINERS: Explainer[] = [
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-5224-74ea-a178-98b80a172286",
    title: "The State of the Israeli Right",
    videoId: "LzEUuRnBXwM",
  },
  {
    show: "call-me-back",
    episodeId: "pod_ep_01a059a0-4c88-76c9-bbfb-cb58aafc4a0d",
    title: "The Only-Bibi Camp vs Never-Bibi Camp",
    videoId: "aPqv68qM9a4",
    credit: "Call Me Back · with Ari Shavit",
  },
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-5034-76b2-843a-dec5f45a52d2",
    title: "The State of the Israeli Center",
    videoId: "Hjfr3G5DuwE",
  },
];

// Ordering is editorial, not chronological — leave it alone unless Ava asks.
//
// One track was dropped when this list moved off the hardcoded Simplecast
// urls: "Sneak Peek: Live with Tal Becker and Nadav Eyal", from the Call Me
// Back AMA feed. That show is paid, so its audio can't be served from a public
// page at all now that the API gates paid audio behind membership — and it has
// no Beehiiv podcast configured to fetch from either.
export const PLAYLIST: CuratedEpisode[] = [
  {
    show: "call-me-back",
    episodeId: "pod_ep_01a059a0-2985-71fc-b0d6-3767ddb237aa",
    title: "A Political Shakeup in Israel? — with Amit Segal and Nadav Eyal",
  },
  {
    show: "call-me-back",
    episodeId: "pod_ep_01a059a0-3caf-7b97-89c4-5ab3a7c4e414",
    title: "The Political Landscape — with Nadav Eyal and Amit Segal",
  },
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-42c5-7bdc-b9c0-6277f8a05ed4",
    title: "Election Currents",
  },
  {
    show: "whats-your-number",
    episodeId: "pod_ep_01a058ad-4280-7c8d-9c85-1715f2165b4c",
    title: "From War Economy to Election Economy",
  },
  {
    show: "for-heavens-sake",
    // The 2026-01-07 original, not the 2026-04-29 re-release.
    episodeId: "pod_ep_01a058c8-4c69-7940-a365-f5806a18a0e1",
    title: "Bennett 2026",
  },
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-5034-76b2-843a-dec5f45a52d2",
    title: "The State of the Israeli Center",
  },
  {
    show: "whats-your-number",
    episodeId: "pod_ep_01a058ad-4606-7b82-8dbd-e776349527fc",
    title: "Is Israel's 2026 Budget a Red Flag?",
  },
  {
    show: "call-me-back",
    episodeId: "pod_ep_01a059a0-4c88-76c9-bbfb-cb58aafc4a0d",
    title: "The Only-Bibi Camp vs Never-Bibi Camp",
  },
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-5224-74ea-a178-98b80a172286",
    title: "The State of the Israeli Right",
  },
  {
    show: "call-me-back",
    episodeId: "pod_ep_01a059a0-4c2d-7a65-bc3e-b2cf0f37aca4",
    title: "Netanyahu Seeks Pardon",
  },
  {
    show: "for-heavens-sake",
    episodeId: "pod_ep_01a058c8-577b-792e-8199-1c0a9dfc02dc",
    title: "Coming Apart",
  },
];
