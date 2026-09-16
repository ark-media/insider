import { useEffect, useState } from "react";
import type { CuratedEpisode } from "../data/israelVotes";
import { fetchEpisodeById } from "./podcasts";

export type EpisodeAudio =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; url: string }
  /** Resolved, but the host has no playable audio for this episode. */
  | { status: "unavailable" };

/**
 * Resolves a curated episode reference to a playable audio url at runtime.
 *
 * Curation lists episodes by their Beehiiv id; the url that actually plays
 * belongs to the host and is never stored in the repo, so it has to be fetched.
 * Pass `null` to defer the request — callers that only reveal a player on
 * demand (a collapsed playlist row) pass the reference in when it opens, which
 * keeps a twelve-track page down to the one request the reader asked for.
 */
export function useEpisodeAudio(ref: CuratedEpisode | null): EpisodeAudio {
  // The result is stamped with the reference it answers, so the status below
  // can be derived rather than reset in an effect: a result whose key doesn't
  // match the current reference is simply "still loading".
  const [resolved, setResolved] = useState<{
    key: string;
    url: string | null;
  } | null>(null);

  const show = ref?.show;
  const episodeId = ref?.episodeId;
  const key = show && episodeId ? `${show}:${episodeId}` : null;

  useEffect(() => {
    if (!show || !episodeId) return;
    let live = true;
    void fetchEpisodeById(show, episodeId).then((episode) => {
      if (!live) return;
      setResolved({ key: `${show}:${episodeId}`, url: episode?.audioUrl ?? null });
    });
    return () => {
      live = false;
    };
  }, [show, episodeId]);

  if (!key) return { status: "idle" };
  if (resolved?.key !== key) return { status: "loading" };
  return resolved.url
    ? { status: "ready", url: resolved.url }
    : { status: "unavailable" };
}
