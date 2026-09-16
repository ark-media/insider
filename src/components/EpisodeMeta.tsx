import { formatDuration, formatEpisodeDate, type Episode } from "../data/episodes";

// The "<date> · <duration>" line shown under an episode title. Renders the text
// only — the caller supplies the wrapper element/styling (the row appears as a
// `span.meta`, a `div.episode-meta`, etc. depending on the card).
export function EpisodeMeta({ episode }: { episode: Episode }) {
  return (
    <>
      {formatEpisodeDate(episode.publishedAt)} ·{" "}
      {formatDuration(episode.durationMinutes)}
    </>
  );
}
