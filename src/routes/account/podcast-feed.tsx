import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FeedSetup } from "../../components/FeedSetup";
import {
  spotifyReturnFromSearch,
  type SpotifyReturn,
} from "../../lib/spotifyReturn";
import { spotifyLinkSuccessUrl } from "../../config/urls";
import { persistFeedsSetUp } from "../../lib/auth";
import { isArkPlusMember, useSubscriberAuth } from "../../lib/subscriberAuth";

// Beehiiv mints the private feeds a short while AFTER the premium tier is
// applied — measured 35s on a live signup (see the cache note in
// server/lib/beehiiv-feeds.ts) — and a member who has just paid reaches this
// page well inside that window. /api/me is fetched once, on mount, so without
// a poll every new member meets an empty checklist and is left to work out
// that reloading fixes it.
//
// Bounded on purpose. Past the window the feeds are not "on their way" any
// more, and saying so is better than a spinner that never resolves.
//
// Counted in ticks the member was actually here for, not wall time: a tab
// sitting in the background shouldn't burn through the window without looking.
const FEED_POLL_INTERVAL_MS = 5_000;
const FEED_POLL_TICKS = 24; // ~2 minutes of visible time

// How long a successful Spotify return waits for its setup write before moving
// on to Spotify's success page anyway.
const SPOTIFY_HANDOFF_WRITE_BUDGET_MS = 3_000;

type PodcastFeedSearch = { spotify?: SpotifyReturn };

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastsTab,
  // `spotify=linked` is the marker on the URL Beehiiv redirects back to (see
  // buildSpotifyHandoff). Beehiiv sends failures back there too, adding
  // `toast=error` — that's a failed link, not a linked one.
  validateSearch: (search: Record<string, unknown>): PodcastFeedSearch => {
    const spotify = spotifyReturnFromSearch(search);
    return spotify ? { spotify } : {};
  },
});

// The Podcasts tab. Auth and the greeting belong to the /account layout; this
// only has to turn away a member without the Ark+ axis, who has no private
// feed to set up.
function PodcastsTab() {
  const navigate = useNavigate();
  const { spotify } = Route.useSearch();
  const { state, refresh } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "member" && !isArkPlusMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  // Entitled but holding nothing: the feeds are still being minted upstream.
  // Re-read /api/me until they land, then stop — `waiting` flips false the
  // moment one arrives, which tears the interval down.
  const waiting =
    state.kind === "member" &&
    state.me.entitlements.arkPlus &&
    state.me.feeds.length === 0;
  const [pollExhausted, setPollExhausted] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    let ticks = 0;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (++ticks > FEED_POLL_TICKS) {
        clearInterval(id);
        setPollExhausted(true);
        return;
      }
      void refresh();
    }, FEED_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [waiting, refresh]);

  // Coming back from Beehiiv's Spotify consent flow.
  //
  // Beehiiv honours the return URL we pass (see buildSpotifyHandoff), so this
  // is the path that confirms the link — the CTA click doesn't, because the
  // member may still cancel at Spotify's consent screen. A failed link returns
  // to the same URL with `toast=error` and arrives here as "failed", so it
  // records nothing and the page stays put to say so.
  //
  // A successful link records every show as set up AND Spotify-linked (one
  // link covers them all), then hands the member on to Spotify's own success
  // page, which lists what the link unlocked. `replace`, so Back doesn't land
  // on this marker and bounce them to Spotify again. The link record is what
  // brings the follow checklist back on this page next time.
  //
  // Beehiiv can't point redirect_path at Spotify's page directly: failures go
  // to redirect_path too, and would land a member whose link failed on a page
  // about a link they don't have.
  //
  // The link is recorded per show, so it waits for the feeds: a member who
  // lands here before /api/me holds any (still being minted, or a failed read)
  // would otherwise leave with nothing written, and the checklist would never
  // come back. The poll above keeps re-reading until they arrive. If it gives
  // up, move on anyway — there's nothing left to record against.
  //
  // The hand-off is dropped if the member leaves this tab first, or turns out
  // not to hold Ark+ (the effect at the top is already sending them away).
  const spotifyLinked = spotify === "linked";
  const handedOff = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!spotifyLinked || handedOff.current) return;
    if (state.kind !== "member" || !state.me.entitlements.arkPlus) return;
    const ids = state.me.feeds.map((f) => f.id);
    if (ids.length === 0 && !pollExhausted) return;
    handedOff.current = true;
    // Leave once the write lands, or after a beat if it hangs — the page is
    // going away, and a lost marker only costs the checklist on a later visit.
    void Promise.race([
      persistFeedsSetUp(ids, { via: "spotify" }),
      new Promise((resolve) => setTimeout(resolve, SPOTIFY_HANDOFF_WRITE_BUDGET_MS)),
    ]).then(() => {
      if (mounted.current) window.location.replace(spotifyLinkSuccessUrl);
    });
  }, [spotifyLinked, state, pollExhausted]);

  if (state.kind !== "member" || !state.me.entitlements.arkPlus) return null;

  return (
    <FeedSetup
      feeds={state.me.feeds}
      spotify={spotify}
      provisioning={waiting && !pollExhausted}
    />
  );
}
