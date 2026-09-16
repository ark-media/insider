/// <reference types="bun" />
// Conversions between the admin's zoned wall-clock entry and the UTC instants
// the API stores. The tricky bits are DST (offset changes within a zone) and
// the round trip, so both seasons are pinned for a couple of zones.

import { describe, test, expect } from "bun:test";
import {
  describeInstant,
  utcToZonedWallClock,
  zonedWallClockToUtc,
} from "./datetime";

describe("zonedWallClockToUtc", () => {
  test("UTC passes through unchanged", () => {
    expect(zonedWallClockToUtc("2026-01-15T09:00", "UTC")).toBe(
      "2026-01-15T09:00:00.000Z",
    );
  });

  test("New York in winter is UTC-5 (EST)", () => {
    expect(zonedWallClockToUtc("2026-01-15T09:00", "America/New_York")).toBe(
      "2026-01-15T14:00:00.000Z",
    );
  });

  test("New York in summer is UTC-4 (EDT)", () => {
    expect(zonedWallClockToUtc("2026-07-15T09:00", "America/New_York")).toBe(
      "2026-07-15T13:00:00.000Z",
    );
  });

  test("Los Angeles in summer is UTC-7 (PDT)", () => {
    expect(zonedWallClockToUtc("2026-07-15T09:00", "America/Los_Angeles")).toBe(
      "2026-07-15T16:00:00.000Z",
    );
  });

  test("rejects a malformed value", () => {
    expect(() => zonedWallClockToUtc("not-a-date", "UTC")).toThrow();
  });
});

describe("describeInstant", () => {
  // Regression: combining dateStyle/timeStyle with timeZoneName threw
  // "Invalid option : option" in V8, crashing the admin ScheduleHint.
  test("renders an instant with a timezone abbreviation", () => {
    const out = describeInstant("2026-07-15T13:00:00.000Z", "America/New_York");
    expect(out).toContain("Jul 15, 2026");
    expect(out).toContain("9:00");
    expect(out).toContain("EDT");
  });
});

describe("utcToZonedWallClock", () => {
  test("renders a UTC instant in the target zone", () => {
    expect(
      utcToZonedWallClock("2026-07-15T13:00:00.000Z", "America/New_York"),
    ).toBe("2026-07-15T09:00");
  });

  test("round-trips with zonedWallClockToUtc across zones and seasons", () => {
    const cases: [string, string][] = [
      ["2026-01-15T09:00", "America/New_York"],
      ["2026-07-15T09:00", "America/New_York"],
      ["2026-07-15T23:30", "America/Los_Angeles"],
      ["2026-03-01T00:00", "Pacific/Honolulu"],
      ["2026-12-31T18:45", "UTC"],
    ];
    for (const [wall, zone] of cases) {
      expect(utcToZonedWallClock(zonedWallClockToUtc(wall, zone), zone)).toBe(
        wall,
      );
    }
  });
});
