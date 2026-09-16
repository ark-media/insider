import { formatCalendarDate } from "../../shared/format-date";
import type { Show, ShowSlug } from "./shows";

/**
 * Episode types + formatting helpers.
 *
 * There is no local episode catalog: episode data is ALWAYS fetched from
 * Beehiiv at runtime (see `src/lib/podcasts.ts`). When Beehiiv has nothing for
 * a show — or the API credentials aren't configured — the UI shows an empty
 * state rather than falling back to hardcoded data.
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
  /** Beehiiv episode id. Stable across renames — our cache and React key. */
  id?: string;
  /**
   * Per-episode artwork URL from Beehiiv. Absent until a producer uploads
   * episode art — callers fall back to the show cover.
   */
  imageUrl?: string;
  /**
   * Sanitized HTML show notes from Beehiiv. Allowlisted on the server before
   * it reaches the client.
   */
  showNotesHtml?: string;
  /**
   * Direct audio URL from Beehiiv. Beehiiv has no embeddable player, so this
   * is what <AudioPlayer> plays. Absent when the episode has no audio yet —
   * callers must render a "listen in your app" fallback rather than a player.
   */
  audioUrl?: string;
};

/**
 * Resolves the artwork to show for an episode: the episode's own image when a
 * producer has uploaded one, otherwise the show cover. Returns null when
 * neither exists so callers can omit the media area entirely.
 */
export function episodeImage(episode: Episode, show: Show): string | null {
  return episode.imageUrl || show.coverArt || null;
}

// A drop date is a calendar date, not an instant — Beehiiv's `displayed_date`
// is converted to 'YYYY-MM-DD' on the server, so it must be formatted without a
// timezone or it renders a day early everywhere west of UTC.
export function formatEpisodeDate(iso: string): string {
  return formatCalendarDate(iso);
}

export function formatEpisodeDateLong(iso: string): string {
  return formatCalendarDate(iso, "longPadded");
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "—";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
