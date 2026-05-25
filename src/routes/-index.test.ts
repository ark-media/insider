/// <reference types="bun" />
// The homepage renders the gift-confirmation Toast iff its search parser maps
// the URL to { gift: "complete" }. A full-tree render would drag in the root
// route's auth providers, so we pin the gate itself — the parser that decides it.
import { describe, expect, test } from "bun:test";
import { Route } from "./index";

const { validateSearch } = (
  Route as unknown as {
    options: {
      validateSearch: (s: Record<string, unknown>) => { gift?: "complete" };
    };
  }
).options;

describe("homepage gift-confirmation search gate", () => {
  test("recognizes ?gift=complete", () => {
    expect(validateSearch({ gift: "complete" })).toEqual({ gift: "complete" });
  });

  test("ignores any other gift value", () => {
    expect(validateSearch({ gift: "yes" })).toEqual({ gift: undefined });
    expect(validateSearch({ gift: "Complete" })).toEqual({ gift: undefined });
    expect(validateSearch({ gift: 1 })).toEqual({ gift: undefined });
  });

  test("ignores a missing param", () => {
    expect(validateSearch({})).toEqual({ gift: undefined });
  });
});
