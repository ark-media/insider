/// <reference types="bun" />
// Unit tests for the things that keep credentials and private surfaces out of
// the two observability vendors:
//   - redactSensitiveQuery / scrubSentryPayload — `mt` is the gift magic link:
//     whoever holds it can log in as the recipient and redeem their gift, so a
//     URL that carries it is an account-takeover primitive sitting in a
//     third-party dashboard.
//   - stashUrlCredentials — gets those params out of the address bar before
//     either SDK initialises, without breaking the claim they exist for.
//   - the PostHog init options and the /account + /admin replay pause.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const g = globalThis as unknown as { document?: unknown; fetch: typeof fetch };
if (!g.document) {
  const realFetch = g.fetch;
  GlobalRegistrator.register();
  g.fetch = realFetch;
}

import { afterEach, beforeEach, describe, test, expect, mock } from "bun:test";

// The module under test imports both SDKs at load time. Stub them so the test
// doesn't need a real key or a network — and record what they're handed.
const posthogCalls = {
  init: [] as Array<{ key: string; config: Record<string, unknown> }>,
  stop: 0,
  start: [] as unknown[],
};
mock.module("posthog-js", () => ({
  default: {
    init: (key: string, config: Record<string, unknown>) => {
      posthogCalls.init.push({ key, config });
    },
    stopSessionRecording: () => {
      posthogCalls.stop += 1;
    },
    startSessionRecording: (override?: unknown) => {
      posthogCalls.start.push(override);
    },
    // initObservability() below flips the module's `posthogReady` for the rest
    // of the process (bun runs every suite in one), so later suites that mount
    // the auth provider reach identify/reset/capture through this stub. It has
    // to be a complete no-op client, not just the methods asserted on here.
    register: () => {},
    reset: () => {},
    capture: () => {},
    identify: () => {},
    group: () => {},
  },
  __esModule: true,
}));
const sentryInits: Array<Record<string, unknown>> = [];
mock.module("@sentry/react", () => ({
  init: (options: Record<string, unknown>) => {
    sentryInits.push(options);
  },
  browserTracingIntegration: (options: unknown) => ({ name: "BrowserTracing", options }),
  setUser: () => {},
  __esModule: true,
}));

import {
  clearLandingCredentials,
  getLandingCredential,
  initObservability,
  isReplayBlockedPath,
  pauseReplayIfSensitive,
  redactSensitiveQuery,
  resumeReplayIfSafe,
  scrubSentryPayload,
  stashUrlCredentials,
} from "./observability";

const setURL = (url: string) =>
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);

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

  test("redacts the email auto-login token and plaintext emails", () => {
    expect(redactSensitiveQuery("https://ark-plus.xyz/api/auth/email-login?lt=abc.def&to=account")).toBe(
      "https://ark-plus.xyz/api/auth/email-login?lt=redacted&to=account",
    );
    const out = redactSensitiveQuery(
      "https://ark-plus.xyz/api/gift/status?id=g_1&email=a%40b.com",
    ) as string;
    expect(out).toContain("id=g_1");
    expect(out).not.toContain("a%40b.com");
  });

  test("redacts RELATIVE urls too — the shape Sentry's navigation breadcrumbs carry", () => {
    expect(redactSensitiveQuery("/redeem?mt=eyJ.abc.def&utm_source=email#top")).toBe(
      "/redeem?mt=redacted&utm_source=email#top",
    );
    expect(redactSensitiveQuery("?id=1&email=a@b.com")).toBe("?id=1&email=redacted");
  });

  test("does not mistake a longer param name for a sensitive one", () => {
    const clean = "/plus?format=mt&estate=1&xtoken=1";
    expect(redactSensitiveQuery(clean)).toBe(clean);
  });

  test("passes through non-strings and unparseable values untouched", () => {
    expect(redactSensitiveQuery(undefined)).toBeUndefined();
    expect(redactSensitiveQuery(null)).toBeNull();
    expect(redactSensitiveQuery(42)).toBe(42);
    expect(redactSensitiveQuery("not a url")).toBe("not a url");
  });
});

describe("scrubSentryPayload", () => {
  const MT = "eyJhbGciOi.SECRET.sig";

  test("navigation breadcrumb: the replaceState that strips mt must not record it", () => {
    const crumb = scrubSentryPayload({
      category: "navigation",
      data: { from: `/redeem?mt=${MT}`, to: "/redeem" },
    });
    expect(crumb.data.from).toBe("/redeem?mt=redacted");
    expect(crumb.data.to).toBe("/redeem");
  });

  test("fetch/xhr breadcrumb urls lose the recipient's email", () => {
    const crumb = scrubSentryPayload({
      category: "fetch",
      data: { method: "GET", url: "/api/gift/status?id=g_1&email=pat%40x.com", status_code: 200 },
    });
    expect(crumb.data.url).toBe("/api/gift/status?id=g_1&email=redacted");
    expect(crumb.data.status_code).toBe(200);
  });

  test("error event: request.url, the Referer header and nested breadcrumbs", () => {
    const event = scrubSentryPayload({
      message: `failed loading https://ark-plus.xyz/redeem?mt=${MT}`,
      request: {
        url: `https://ark-plus.xyz/redeem?mt=${MT}`,
        headers: { Referer: `https://ark-plus.xyz/redeem?token=gift_${MT}` },
      },
      breadcrumbs: [{ category: "navigation", data: { from: `/redeem?mt=${MT}`, to: "/welcome" } }],
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
    expect(event.request.url).toBe("https://ark-plus.xyz/redeem?mt=redacted");
  });

  test("transaction: trace data (url.full), span descriptions and span http attributes", () => {
    const event = scrubSentryPayload({
      type: "transaction",
      transaction: "/redeem",
      contexts: {
        trace: { op: "pageload", data: { "url.full": `https://ark-plus.xyz/redeem?mt=${MT}` } },
      },
      spans: [
        {
          op: "http.client",
          description: "GET /api/gift/status?id=g_1&email=pat%40x.com",
          data: {
            "http.url": "https://ark-plus.xyz/api/gift/status?id=g_1&email=pat%40x.com",
            "url.full": "https://ark-plus.xyz/api/gift/status?id=g_1&email=pat%40x.com",
            "http.query": "?id=g_1&email=pat%40x.com",
            "http.response.status_code": 200,
          },
        },
      ],
    });
    const json = JSON.stringify(event);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("pat%40x.com");
    expect(event.spans[0]!.data["http.query"]).toBe("?id=g_1&email=redacted");
    expect(event.spans[0]!.data["http.response.status_code"]).toBe(200);
    expect(event.transaction).toBe("/redeem");
  });

  test("survives cycles, class instances and non-objects", () => {
    const cyclic: Record<string, unknown> = { url: "/redeem?mt=abc" };
    cyclic.self = cyclic;
    cyclic.when = new Date(0);
    expect(() => scrubSentryPayload(cyclic)).not.toThrow();
    expect(cyclic.url).toBe("/redeem?mt=redacted");
    expect(scrubSentryPayload(null)).toBeNull();
    expect(scrubSentryPayload("x")).toBe("x");
  });
});

describe("stashUrlCredentials", () => {
  beforeEach(() => {
    clearLandingCredentials();
  });
  afterEach(() => {
    clearLandingCredentials();
    setURL("about:blank");
  });

  test("lifts mt out of the address bar and keeps the rest of the URL", () => {
    setURL("https://ark-plus.xyz/redeem?mt=MAGIC&utm_source=email#gift");
    stashUrlCredentials();
    expect(window.location.href).toBe("https://ark-plus.xyz/redeem?utm_source=email#gift");
    expect(getLandingCredential("mt")).toBe("MAGIC");
    // mt is memory-only: it must never be written to storage.
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain("MAGIC");
  });

  test("the legacy token survives the sign-in round trip via sessionStorage", () => {
    setURL("https://ark-plus.xyz/redeem?token=gift_abc");
    stashUrlCredentials();
    // The address bar is what signIn() builds `returnTo` from.
    expect(window.location.pathname + window.location.search).toBe("/redeem");
    expect(getLandingCredential("token")).toBe("gift_abc");

    // Back from Auth0: a new document, so the in-memory holder is empty and the
    // URL is the clean returnTo. Simulated by re-stashing on the clean URL after
    // dropping the memory copy but not the stored one.
    const stored = window.sessionStorage.getItem("ark_gift_claim_token");
    clearLandingCredentials();
    window.sessionStorage.setItem("ark_gift_claim_token", stored!);
    stashUrlCredentials();
    expect(getLandingCredential("token")).toBe("gift_abc");

    // …and a finished claim spends it.
    clearLandingCredentials();
    expect(getLandingCredential("token")).toBeUndefined();
  });

  test("if sessionStorage is unavailable the token STAYS in the URL (a working gift beats a tidy URL)", () => {
    setURL("https://ark-plus.xyz/redeem?token=gift_abc&mt=MAGIC");
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      stashUrlCredentials();
      expect(window.location.search).toBe("?token=gift_abc");
      expect(getLandingCredential("token")).toBe("gift_abc");
      expect(getLandingCredential("mt")).toBe("MAGIC");
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
      else delete (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    }
  });

  test("leaves `token` alone on every other page", () => {
    setURL("https://ark-plus.xyz/plus?token=not-ours&mt=nor-this");
    stashUrlCredentials();
    expect(window.location.search).toBe("?token=not-ours&mt=nor-this");
    expect(getLandingCredential("mt")).toBeUndefined();
    expect(getLandingCredential("token")).toBeUndefined();
  });
});

describe("isReplayBlockedPath", () => {
  test("blocks /account and /admin and everything under them", () => {
    for (const path of ["/account", "/account/billing", "/admin", "/admin/open-houses"]) {
      expect(isReplayBlockedPath(path)).toBe(true);
    }
  });

  test("does not block look-alike or public paths", () => {
    for (const path of ["/", "/plus", "/accounting", "/administrivia", "/shows/account"]) {
      expect(isReplayBlockedPath(path)).toBe(false);
    }
  });
});

describe("initObservability", () => {
  const env = import.meta.env as Record<string, string | undefined>;

  afterEach(() => {
    delete env.VITE_POSTHOG_KEY;
    delete env.VITE_SENTRY_DSN;
    setURL("about:blank");
  });

  test("before init, the replay hooks are inert", () => {
    pauseReplayIfSensitive("/account");
    resumeReplayIfSafe("/plus");
    expect(posthogCalls.stop).toBe(0);
    expect(posthogCalls.start).toEqual([]);
  });

  test("Sentry is given a scrubber on every exit", () => {
    env.VITE_SENTRY_DSN = "https://k@o0.ingest.sentry.io/1";
    initObservability();
    const options = sentryInits.at(-1)!;
    for (const hook of ["beforeBreadcrumb", "beforeSend", "beforeSendTransaction"] as const) {
      const fn = options[hook] as (x: unknown) => { data: { from: string } };
      expect(fn({ data: { from: "/redeem?mt=abc" } }).data.from).toBe("/redeem?mt=redacted");
    }
    const tracing = (options.integrations as Array<{ options: { beforeStartSpan: unknown } }>)[0]!;
    const beforeStartSpan = tracing.options.beforeStartSpan as (o: unknown) => {
      attributes: Record<string, string>;
    };
    expect(
      beforeStartSpan({ name: "/redeem", attributes: { "url.full": "https://x.y/redeem?mt=abc" } })
        .attributes["url.full"],
    ).toBe("https://x.y/redeem?mt=redacted");
  });

  test("PostHog masks replay text + inputs, autocapture text + attributes, and pauses on sensitive routes", () => {
    env.VITE_POSTHOG_KEY = "phc_test";
    setURL("https://ark-plus.xyz/plus");
    initObservability();

    const { config } = posthogCalls.init.at(-1)!;
    expect(config.mask_all_text).toBe(true);
    expect(config.mask_all_element_attributes).toBe(true);
    expect(config.session_recording).toEqual({
      maskAllInputs: true,
      maskTextSelector: "*",
      blockSelector: "[data-ph-block]",
    });
    expect(config.disable_session_recording).toBe(false);

    // Public page → nothing to do.
    pauseReplayIfSensitive("/shows");
    expect(posthogCalls.stop).toBe(0);

    // Arriving at /account stops the recorder, once.
    pauseReplayIfSensitive("/account/billing");
    pauseReplayIfSensitive("/account/profile");
    expect(posthogCalls.stop).toBe(1);

    // Still on a sensitive page when it renders → stays off.
    resumeReplayIfSafe("/account/profile");
    expect(posthogCalls.start).toEqual([]);

    // The next public page has rendered → back on, under the project's own
    // sampling rules (no override argument).
    resumeReplayIfSafe("/plus");
    resumeReplayIfSafe("/plus");
    expect(posthogCalls.start).toEqual([undefined]);
  });

  test("a session that STARTS on /admin never begins recording", () => {
    env.VITE_POSTHOG_KEY = "phc_test";
    setURL("https://ark-plus.xyz/admin/open-houses");
    initObservability();
    expect(posthogCalls.init.at(-1)!.config.disable_session_recording).toBe(true);

    const startsBefore = posthogCalls.start.length;
    resumeReplayIfSafe("/");
    expect(posthogCalls.start.length).toBe(startsBefore + 1);
  });
});
