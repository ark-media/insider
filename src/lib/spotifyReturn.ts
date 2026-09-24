/**
 * How the member came back from the Spotify hand-off. Every return carries our
 * own `spotify=linked` marker, because it's part of the redirect_path we hand
 * Beehiiv — including a failed link, which Beehiiv flags by appending
 * `toast=error`. So "linked" is the marker WITHOUT that flag.
 */
export type SpotifyReturn = "linked" | "failed";

export function spotifyReturnFromSearch(
  search: Record<string, unknown>,
): SpotifyReturn | undefined {
  if (search.spotify !== "linked") return undefined;
  return search.toast === "error" ? "failed" : "linked";
}
