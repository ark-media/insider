import type { Episode } from "../data/episodes";
import type { ShowSlug } from "../data/shows";

/**
 * Simplecast client. Fetches episodes from /api/simplecast/episodes, which
 * proxies the Simplecast API server-side (the API token can't ride along
 * with the client). Simplecast is the single source of truth for episode
 * data — there is no local catalog. When the server returns nothing (paid
 * show with no Simplecast podcast, or dev environment without a token), the
 * caller gets an empty list and the UI shows an empty state.
 */

type ApiResponse = { episodes?: Episode[] };

async function fetchEpisodesFromApi(showSlug: ShowSlug): Promise<Episode[] | null> {
  try {
    const res = await fetch(
      `/api/simplecast/episodes?show=${encodeURIComponent(showSlug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as ApiResponse;
    return body.episodes ?? [];
  } catch {
    return null;
  }
}

export async function listEpisodes(showSlug: ShowSlug): Promise<Episode[]> {
  return (await fetchEpisodesFromApi(showSlug)) ?? [];
}

export async function getEpisode(
  showSlug: ShowSlug,
  slug: string,
): Promise<Episode | null> {
  const all = await listEpisodes(showSlug);
  return all.find((e) => e.slug === slug) ?? null;
}

/**
 * Fetches show notes + description for a single Simplecast episode by id.
 * The list endpoint returns slim episode summaries (no description /
 * long_description), so the episode page calls this with the id from the
 * list response to fill in the show notes section. Returns null on failure
 * — the page falls back to whatever the list / mock supplied.
 */
export async function fetchEpisodeNotes(
  episodeId: string,
): Promise<{ showNotesHtml: string; description: string } | null> {
  try {
    const res = await fetch(
      `/api/simplecast/episode?id=${encodeURIComponent(episodeId)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      showNotesHtml?: string;
      description?: string;
    };
    return {
      showNotesHtml: body.showNotesHtml ?? "",
      description: body.description ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Fetches the show-level description from Simplecast for a show. Returns an
 * empty string when the show has no Simplecast podcast configured, the server
 * has no token, or the request fails — callers fall back to the hand-written
 * tagline in that case.
 */
export async function fetchShowDescription(showSlug: ShowSlug): Promise<string> {
  try {
    const res = await fetch(
      `/api/simplecast/podcast?show=${encodeURIComponent(showSlug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return "";
    const body = (await res.json()) as { description?: string };
    return body.description ?? "";
  } catch {
    return "";
  }
}

/**
 * Per-episode Simplecast player. Takes the Simplecast episode UUID
 * (Episode.id from the API). Dark theme to match the rest of the site.
 */
export function simplecastEpisodeSrc(episodeId: string): string {
  return `https://player.simplecast.com/${encodeURIComponent(episodeId)}?dark=true`;
}
