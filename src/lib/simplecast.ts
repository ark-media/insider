import { episodes, type Episode } from "../data/episodes";
import type { ShowSlug } from "../data/shows";

/**
 * Mock Simplecast API client.
 *
 * Real implementation would call the Simplecast Episodes API and project the
 * raw fields down to the {@link Episode} shape. Paid shows
 * (`inside-call-me-back`) read against the SupportingCast admin API in real
 * life — the public surface here returns episode titles + dates only, never
 * audio. That mirrors the proposal's "names only, no audio" rule for the
 * paid show's public marketing page.
 */

const FAKE_LATENCY_MS = 90;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 50));
}

export async function listEpisodes(showSlug: ShowSlug): Promise<Episode[]> {
  await jitter();
  return episodes
    .filter((e) => e.showSlug === showSlug)
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() -
        new Date(a.publishedAt).getTime(),
    );
}

export async function getEpisode(
  showSlug: ShowSlug,
  slug: string,
): Promise<Episode | null> {
  await jitter();
  return (
    episodes.find((e) => e.showSlug === showSlug && e.slug === slug) ?? null
  );
}

/**
 * Simplecast embed URL for a given episode. The real API exposes a stable
 * embed URL keyed by episode id; here we pretend the slug is the id.
 */
export function simplecastEmbedSrc(showSlug: ShowSlug, slug: string): string {
  return `https://player.simplecast.com/${encodeURIComponent(
    showSlug,
  )}/${encodeURIComponent(slug)}`;
}

/**
 * Simplecast show-level playlist embed — the player + episode list iframe
 * exposed under Distribution → Embeds → All Episodes in the Simplecast
 * dashboard. Renders dark to match the rest of the site.
 */
export function simplecastPlaylistSrc(podcastId: string): string {
  return `https://player.simplecast.com/${encodeURIComponent(podcastId)}?dark=true`;
}

/**
 * Resolve a show's Simplecast podcast UUID from build-time env vars.
 * Mapping: `call-me-back` → `VITE_SIMPLECAST_PODCAST_ID_CALL_ME_BACK`.
 * Returns undefined (no player rendered) when the var is unset.
 */
export function simplecastPodcastIdForShow(showSlug: ShowSlug): string | undefined {
  const key = `VITE_SIMPLECAST_PODCAST_ID_${showSlug.toUpperCase().replace(/-/g, "_")}`;
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value && value.trim() ? value.trim() : undefined;
}
