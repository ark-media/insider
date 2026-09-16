// Unit tests for redactSensitiveQuery — the last line of defense keeping bearer
// credentials out of PostHog. `mt` is the gift magic link: whoever holds it can
// log in as the recipient and redeem their gift, so a $current_url that carries
// it is an account-takeover primitive sitting in a third-party dashboard.

import { describe, test, expect, mock } from "bun:test";

// The module under test imports both SDKs at load time. Stub them so the test
// doesn't need a real key, a DOM, or a network.
mock.module("posthog-js", () => ({ default: { init: () => {} }, __esModule: true }));
mock.module("@sentry/react", () => ({
  init: () => {},
  browserTracingIntegration: () => ({}),
  setUser: () => {},
  __esModule: true,
}));

import { redactSensitiveQuery } from "./observability";

describe("redactSensitiveQuery", () => {
  test("redacts the gift magic-link token", () => {
    expect(redactSensitiveQuery("https://ark-plus.xyz/redeem?mt=eyJhbGciOi.abc.def")).toBe(
      "https://ark-plus.xyz/redeem?mt=redacted",
    );
  });

  test("redacts every sensitive key and keeps the rest of the URL intact", () => {
    const out = redactSensitiveQuery(
      "https://ark-plus.xyz/redeem?utm_source=email&mt=secret&session_id=cs_live_1&page=2",
    ) as string;
    expect(out).toContain("utm_source=email");
    expect(out).toContain("page=2");
    expect(out).toContain("mt=redacted");
    expect(out).toContain("session_id=redacted");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("cs_live_1");
  });

  test("redacts OAuth code/state and the generic token param", () => {
    expect(redactSensitiveQuery("https://ark-plus.xyz/cb?code=abc&state=xyz")).toBe(
      "https://ark-plus.xyz/cb?code=redacted&state=redacted",
    );
    expect(redactSensitiveQuery("https://ark-plus.xyz/redeem?token=gift_abc")).toBe(
      "https://ark-plus.xyz/redeem?token=redacted",
    );
  });

  test("leaves URLs without sensitive params byte-identical", () => {
    const clean = "https://ark-plus.xyz/plus?tier=bundle#pricing";
    expect(redactSensitiveQuery(clean)).toBe(clean);
  });

  test("passes through non-strings and unparseable values untouched", () => {
    expect(redactSensitiveQuery(undefined)).toBeUndefined();
    expect(redactSensitiveQuery(null)).toBeNull();
    expect(redactSensitiveQuery(42)).toBe(42);
    expect(redactSensitiveQuery("not a url")).toBe("not a url");
  });
});
