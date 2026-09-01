import type { Episode } from "../data/episodes";
import { shows, type Show, type ShowSlug } from "../data/shows";

/**
 * Podcast client. Fetches episodes from /api/podcasts/episodes, which proxies
 * the Beehiiv Podcasts API server-side (the API key can't ride along with the
 * client). Beehiiv is the single source of truth for episode data — there is
 * no local catalog. A successful empty response is a genuine empty state (paid
 * show with no Beehiiv podcast, or dev without credentials); a network/non-2xx
 * failure THROWS so callers can distinguish "failed to load" from "no episodes"
 * and render an error+retry instead of spinning forever.
 */

type ApiResponse = { episodes?: Episode[] };

async function fetchEpisodesFromApi(showSlug: ShowSlug): Promise<Episode[]> {
  const res = await fetch(
    `/api/podcasts/episodes?show=${encodeURIComponent(showSlug)}`,
    { credentials: "same-origin" },
  );
  if (!res.ok) throw new Error(`episodes request failed (${res.status})`);
  const body = (await res.json()) as ApiResponse;
  return body.episodes ?? [];
}

export async function listEpisodes(showSlug: ShowSlug): Promise<Episode[]> {
  return fetchEpisodesFromApi(showSlug);
}

export type EpisodeWithShow = Episode & { show: Show };

/** Most recent episodes across all public shows, newest first. */
export async function listLatestEpisodes(
  limit = 3,
): Promise<Array<EpisodeWithShow>> {
  const publicShows = shows.filter((show) => !show.paid);
  const byShow = await Promise.all(
    publicShows.map(async (show) => {
      const episodes = await listEpisodes(show.slug);
      return episodes.map((episode) => ({ ...episode, show }));
    }),
  );
  return byShow
    .flat()
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
    )
    .slice(0, limit);
}

export async function getEpisode(
  showSlug: ShowSlug,
  slug: string,
): Promise<Episode | null> {
  // The single-episode route degrades to its pre-loaded summary on failure, so
  // keep this tolerant (null) rather than propagating the throw from listEpisodes.
  try {
    const all = await listEpisodes(showSlug);
    return all.find((e) => e.slug === slug) ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetches show notes + description for a single Beehiiv episode.
 *
 * Beehiiv returns `show_notes` on the list endpoint, so unlike Simplecast this
 * is no longer required to render show notes — the episode page already has
 * them from the list. It stays as a refresh for episodes whose notes were
 * corrected after the list cache warmed. Returns null on failure; the page
 * falls back to what the list supplied.
 */
export async function fetchEpisodeNotes(
  showSlug: ShowSlug,
  episodeId: string,
): Promise<{ showNotesHtml: string; description: string } | null> {
  try {
    const res = await fetch(
      `/api/podcasts/episode?show=${encodeURIComponent(showSlug)}&id=${encodeURIComponent(episodeId)}`,
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
 * Fetches the show-level description from Beehiiv for a show. Returns an empty
 * string when the show has no Beehiiv podcast configured, the server has no
 * credentials, or the request fails — callers fall back to the hand-written
 * tagline in that case.
 */
export async function fetchShowDescription(showSlug: ShowSlug): Promise<string> {
  try {
    const res = await fetch(
      `/api/podcasts/show?show=${encodeURIComponent(showSlug)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) return "";
    const body = (await res.json()) as { description?: string };
    return body.description ?? "";
  } catch {
    return "";
  }
}
