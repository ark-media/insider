/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  amazonUrl,
  announceDate,
  danBooks,
  getBuyLinks,
  getCurrentPick,
  getPastPicks,
  getUpcomingPicks,
} from "./bookClub";

const slugs = (picks: { slug: string }[]) => picks.map((p) => p.slug);

describe("announceDate", () => {
  it("is the 15th of the month before", () => {
    expect(announceDate("2026-11")).toBe("2026-10-15");
  });
  it("wraps January back to the previous December", () => {
    expect(announceDate("2027-01")).toBe("2026-12-15");
  });
});

describe("book club calendar", () => {
  it("before the club starts, the first pick is current and nothing else shows", () => {
    expect(getCurrentPick("2026-09-23")?.slug).toBe("the-pity-of-it-all");
    expect(getUpcomingPicks("2026-09-23")).toEqual([]);
    expect(getPastPicks("2026-09-23")).toEqual([]);
  });

  it("keeps On deck hidden until the 15th", () => {
    expect(getUpcomingPicks("2026-10-14")).toEqual([]);
    expect(slugs(getUpcomingPicks("2026-10-15"))).toEqual(["the-cauldron"]);
  });

  it("rolls the month over: October becomes a past pick", () => {
    expect(getCurrentPick("2026-11-01")?.slug).toBe("the-cauldron");
    expect(slugs(getPastPicks("2026-11-01"))).toEqual(["the-pity-of-it-all"]);
    expect(getUpcomingPicks("2026-11-01")).toEqual([]);
    expect(slugs(getUpcomingPicks("2026-11-15"))).toEqual(["submission"]);
  });

  it("lists past picks newest first", () => {
    expect(slugs(getPastPicks("2027-01-10"))).toEqual([
      "submission",
      "the-cauldron",
      "the-pity-of-it-all",
    ]);
  });

  it("holds on the last pick once the catalogue runs out", () => {
    expect(getCurrentPick("2027-06-01")?.slug).toBe("american-pastoral");
  });
});

describe("getBuyLinks", () => {
  it("prefers the per-format affiliate links", () => {
    const links = getBuyLinks(getCurrentPick("2026-10-01")!);
    expect(links.map((l) => l.format)).toEqual([
      "Paperback",
      "Hardcover",
      "Kindle",
    ]);
    expect(links.every((l) => l.url.startsWith("https://amzn.to/"))).toBe(true);
  });

  it("falls back to a tagged ASIN link", () => {
    const cauldron = getCurrentPick("2026-11-01")!;
    expect(getBuyLinks(cauldron)).toEqual([
      { url: amazonUrl(cauldron.amazonAsin) },
    ]);
    expect(amazonUrl("X")).toContain("tag=danbookclub-20");
  });

  it("gives Dan's own books their affiliate links", () => {
    for (const book of danBooks)
      expect(book.buyLinks?.length).toBeGreaterThan(0);
  });
});
