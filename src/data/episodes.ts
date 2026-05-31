import type { Show, ShowSlug } from "./shows";

/**
 * Episode types + formatting helpers.
 *
 * There is no local episode catalog: episode data is ALWAYS fetched from
 * Simplecast at runtime (see `src/lib/simplecast.ts`). When Simplecast has
 * nothing for a show — or the API token isn't configured — the UI shows an
 * empty state rather than falling back to hardcoded data.
 */

export type Episode = {
  showSlug: ShowSlug;
  slug: string;
  title: string;
  /** ISO date — when the episode dropped */
  publishedAt: string;
  durationMinutes: number;
  description: string;
  /** Optional list of guest names. */
  guests?: string[];
  /**
   * Simplecast episode UUID. Drives the embedded Simplecast player on the
   * episode page.
   */
  id?: string;
  /**
   * Per-episode artwork URL from Simplecast. Absent until a producer uploads
   * episode art — callers fall back to the show cover.
   */
  imageUrl?: string;
  /**
   * Sanitized HTML show notes from Simplecast. Allowlisted on the server
   * before it reaches the client.
   */
  showNotesHtml?: string;
};

/**
 * Resolves the artwork to show for an episode: the episode's own image when a
 * producer has uploaded one, otherwise the show cover. Returns null when
 * neither exists so callers can omit the media area entirely.
 */
export function episodeImage(episode: Episode, show: Show): string | null {
  return episode.imageUrl || show.coverArt || null;
}

export function formatEpisodeDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
