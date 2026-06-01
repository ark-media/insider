/// <reference types="bun" />
// Live/upcoming classification for the community events strip. The window math
// (start ≤ now < start+duration) and the live/upcoming/excluded buckets are the
// tricky bits, so they're pinned against an injected `now` — never wall-clock.

import { describe, test, expect } from "bun:test";
import { liveAndUpcomingEvents } from "./events";

// evt-2026-05-04-cmb-live runs 2026-05-04T23:00Z for 75min → ends 00:15Z.
const LIVE_EVENT = "evt-2026-05-04-cmb-live";
const NEXT_EVENT = "evt-2026-05-08-fhs-ama";

describe("liveAndUpcomingEvents", () => {
  test("an event whose window contains `now` is classified live", () => {
    const now = new Date("2026-05-04T23:30:00Z");
    const byId = new Map(
      liveAndUpcomingEvents(now).map((x) => [x.event.id, x.status]),
    );
    expect(byId.get(LIVE_EVENT)).toBe("live");
    expect(byId.get(NEXT_EVENT)).toBe("upcoming");
  });

  test("a future event is upcoming", () => {
    const now = new Date("2026-05-04T23:30:00Z");
    const next = liveAndUpcomingEvents(now).find(
      (x) => x.event.id === NEXT_EVENT,
    );
    expect(next?.status).toBe("upcoming");
  });

  test("a past (ended) event is excluded", () => {
    // After the live event has ended, before the next one starts.
    const now = new Date("2026-05-06T00:00:00Z");
    const ids = liveAndUpcomingEvents(now).map((x) => x.event.id);
    expect(ids).not.toContain(LIVE_EVENT);
    expect(ids).toContain(NEXT_EVENT);
  });

  test("the start instant is live; the end instant is excluded", () => {
    const start = new Date("2026-05-04T23:00:00Z");
    const end = new Date("2026-05-05T00:15:00Z");

    const atStart = liveAndUpcomingEvents(start).find(
      (x) => x.event.id === LIVE_EVENT,
    );
    expect(atStart?.status).toBe("live");

    const atEnd = liveAndUpcomingEvents(end).map((x) => x.event.id);
    expect(atEnd).not.toContain(LIVE_EVENT);
  });

  test("results are sorted live-first, then soonest", () => {
    const now = new Date("2026-05-04T23:30:00Z");
    const results = liveAndUpcomingEvents(now);
    const firstUpcoming = results.findIndex((x) => x.status === "upcoming");
    // Every live item precedes every upcoming item.
    expect(
      results.slice(0, firstUpcoming).every((x) => x.status === "live"),
    ).toBe(true);
    // Upcoming items are in ascending start order.
    const upcomingStarts = results
      .filter((x) => x.status === "upcoming")
      .map((x) => new Date(x.event.startsAt).getTime());
    const sorted = [...upcomingStarts].sort((a, b) => a - b);
    expect(upcomingStarts).toEqual(sorted);
  });
});
