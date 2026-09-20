import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FeedSetup } from "../../components/FeedSetup";
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

type PodcastFeedSearch = { spotify?: "linked" };

export const Route = createFileRoute("/account/podcast-feed")({
  component: PodcastsTab,
  // `spotify=linked` is the marker Beehiiv redirects back with once Open
  // Access has been authorized (see buildSpotifyHandoff).
  validateSearch: (search: Record<string, unknown>): PodcastFeedSearch =>
    search.spotify === "linked" ? { spotify: "linked" as const } : {},
});

// The Podcasts tab. Auth and the greeting belong to the /account layout; this
// only has to turn away a member without the Ark+ axis, who has no private
// feed to set up.
function PodcastsTab() {
  const navigate = useNavigate();
  const { spotify } = Route.useSearch();
  const { state, markFeedsSetUp, refresh } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "member" && !isArkPlusMember(state)) {
      void navigate({ to: "/account" });
    }
  }, [state, navigate]);

  // Coming back from Beehiiv's Spotify consent flow.
  //
  // Beehiiv honours the return URL we pass (see buildSpotifyHandoff), so this
  // is the path that confirms the link — the CTA is a same-tab hand-off and
  // the follow step keys off this marker, not the click.
  //
  // It deliberately stays in the URL rather than being read into state: the URL
  // is the one place that survives whatever the router and the auth refresh do
  // to this subtree, and it stays true on a reload.
  //
  // The Spotify CTA already marks the show set up on click, but redo it here
  // too — a same-tab navigation can cancel that request mid-flight, and this
  // is the path that is guaranteed to run. Marking is idempotent (it only ever
  // flips a feed that isn't already set up), which is what makes it safe to
  // leave the marker in the URL.
  const spotifyLinked = spotify === "linked";
  const marked = useRef(false);
  useEffect(() => {
    if (!spotifyLinked || state.kind !== "member" || marked.current) return;
    marked.current = true;
    markFeedsSetUp(state.me.feeds.map((f) => f.id));
  }, [spotifyLinked, state, markFeedsSetUp]);

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

  if (state.kind !== "member" || !state.me.entitlements.arkPlus) return null;

  return (
    <FeedSetup
      feeds={state.me.feeds}
      spotifyLinked={spotifyLinked}
      provisioning={waiting && !pollExhausted}
    />
  );
}
