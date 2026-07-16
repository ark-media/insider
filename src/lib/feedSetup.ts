// Optimistic "which feeds has this member set up" tracking.
//
// The authoritative signal is server-side: Supporting Cast fires a
// `feed.activated` webhook the first time a listener actually adds/opens a
// private feed, which we (will) persist and surface as `UserFeed.activated`.
// That truth can lag the click by minutes, so we ALSO remember locally the
// moment a member finishes a feed's setup action (opens the deep link, copies
// the URL, texts themselves the link, or links Spotify for the whole network).
// The setup hub treats a feed as done if EITHER source says so — instant
// check-off, reconciled by the webhook on the next /api/me.
//
// Local state is intentionally lightweight (a list of feed ids in
// localStorage). It only ever makes the counter more complete, never less, so
// a stale entry can't hide a feed that still needs setting up.

import { useEffect, useState } from "react";
import type { UserFeed } from "./auth";

const KEY = "ark:feedsSetUp";

// Module-level fan-out so every mounted hook re-reads after a write in the same
// tab (the native `storage` event only fires in OTHER tabs).
const listeners = new Set<() => void>();

function read(): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(arr) ? arr.filter((n): n is number => typeof n === "number") : [],
    );
  } catch {
    return new Set();
  }
}

function write(ids: Set<number>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode / quota — the counter just stays server-driven */
  }
  listeners.forEach((l) => l());
}

/** Mark a single feed as set up locally (idempotent). */
export function markFeedSetUp(feedId: number): void {
  const ids = read();
  if (ids.has(feedId)) return;
  ids.add(feedId);
  write(ids);
}

/** Mark several feeds at once — used by the Spotify "whole network" link. */
export function markFeedsSetUp(feedIds: number[]): void {
  const ids = read();
  let changed = false;
  for (const id of feedIds) {
    if (!ids.has(id)) {
      ids.add(id);
      changed = true;
    }
  }
  if (changed) write(ids);
}

/** True if the server OR the local optimistic record says this feed is set up. */
export function feedIsSetUp(feed: UserFeed, localIds: Set<number>): boolean {
  return feed.activated === true || localIds.has(feed.id);
}

/**
 * Reactive view of the locally-remembered set-up feed ids. Re-renders on writes
 * from this tab (via the listener set) and from other tabs (via `storage`).
 */
export function useLocalSetUpIds(): Set<number> {
  const [ids, setIds] = useState<Set<number>>(read);
  useEffect(() => {
    const refresh = () => setIds(read());
    listeners.add(refresh);
    window.addEventListener("storage", refresh);
    // Re-read on mount in case another tab wrote before we subscribed.
    refresh();
    return () => {
      listeners.delete(refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return ids;
}
