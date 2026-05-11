import { episodes as mockEpisodes, type Episode } from "../data/episodes";
import type { ShowSlug } from "../data/shows";

/**
 * Simplecast client. Fetches episodes from /api/simplecast/episodes, which
 * proxies the Simplecast API server-side (the API token can't ride along
 * with the client). When the server returns an empty list — paid show with
 * no Simplecast podcast, or dev environment without a token — we fall back
 * to the local mock catalog so the UI keeps working.
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

function mockListEpisodes(showSlug: ShowSlug): Episode[] {
  return mockEpisodes
    .filter((e) => e.showSlug === showSlug)
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() -
        new Date(a.publishedAt).getTime(),
    );
}

export async function listEpisodes(showSlug: ShowSlug): Promise<Episode[]> {
  const remote = await fetchEpisodesFromApi(showSlug);
  if (remote && remote.length > 0) return remote;
  return mockListEpisodes(showSlug);
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
 * Per-episode Simplecast player. Takes the Simplecast episode UUID
 * (Episode.id from the API). Dark theme to match the rest of the site.
 */
export function simplecastEpisodeSrc(episodeId: string): string {
  return `https://player.simplecast.com/${encodeURIComponent(episodeId)}?dark=true`;
}
