import {
  communityBroadcasts,
  type CommunityBroadcast,
} from "../data/communityBroadcasts";
import { upcomingEvents, type ArkEvent } from "../data/events";

/**
 * Mock Circle headless client.
 *
 * Real implementation would call Circle's admin API with a server-side token
 * (BCommunity SSO + headless reads). Each function here returns the same shape
 * the real API would, after light projection — so the UI is stable when we
 * swap to a real fetcher.
 */

const FAKE_LATENCY_MS = 80;

function jitter(ms = FAKE_LATENCY_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms + Math.random() * 40));
}

export async function fetchPublicBroadcasts(): Promise<CommunityBroadcast[]> {
  await jitter();
  return communityBroadcasts;
}

export async function fetchUpcomingEvents(): Promise<ArkEvent[]> {
  await jitter();
  return upcomingEvents();
}

/**
 * Build a deep link into the Circle app for a given event. Real implementation
 * would call Circle's deep-link endpoint, which signs the link so the app can
 * land the user directly on the event view (member or guest).
 */
export function circleEventLink(eventId: string): string {
  return `https://community.arkmedia.org/events/${eventId}`;
}

/** Universal app-open link — used by /account "Open in app" buttons. */
export const CIRCLE_OPEN_LINKS = {
  ios: "https://apps.apple.com/app/circle-communities/id1525026498",
  android:
    "https://play.google.com/store/apps/details?id=com.circle.circleapp",
  web: "https://community.arkmedia.org",
};
