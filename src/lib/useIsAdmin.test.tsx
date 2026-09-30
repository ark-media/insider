/// <reference types="bun" />
// The admin check behind the /admin gate and the Admin tab on /account.
//
// What's pinned is every frame, not just where it settles: the old version set
// "not loading" while the session resolved, so an admin arriving at /admin got
// one painted frame of "Not authorized" before the spinner.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const g = globalThis as unknown as {
  document?: unknown;
  IS_REACT_ACT_ENVIRONMENT?: boolean;
  fetch: typeof fetch;
};
if (!g.document) {
  const realFetch = g.fetch;
  GlobalRegistrator.register();
  g.fetch = realFetch;
}
g.IS_REACT_ACT_ENVIRONMENT = true;

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AdminMe } from "./admin";

// Only the read is stubbed — `mock.module` is process-wide and other suites
// import from this module, so everything else stays real.
const realAdmin = await import("./admin");
let pending: Array<{ email: string; resolve: (me: AdminMe) => void }> = [];
let currentEmail = "";
mock.module("./admin", () => ({
  ...realAdmin,
  fetchAdminMe: () =>
    new Promise<AdminMe>((resolve) => {
      pending.push({ email: currentEmail, resolve });
    }),
}));

const { useIsAdmin } = await import("./useIsAdmin");

type Frame = { loading: boolean; isAdmin: boolean };
let frames: Frame[] = [];
function Probe({ email }: { email: string | null }) {
  frames.push(useIsAdmin(email));
  return null;
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(email: string | null) {
  currentEmail = email ?? "";
  if (!mounted) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    mounted = { root: createRoot(container), container };
  }
  const { root } = mounted;
  await act(async () => root.render(<Probe email={email} />));
}

async function answer(isAdmin: boolean) {
  const next = pending.shift()!;
  await act(async () => next.resolve({ isAdmin, email: next.email }));
}

const last = () => frames[frames.length - 1];

beforeEach(() => {
  pending = [];
  frames = [];
});

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
});

describe("useIsAdmin", () => {
  test("no member: not loading, not an admin, and nothing is asked", async () => {
    await render(null);

    expect(last()).toEqual({ loading: false, isAdmin: false });
    expect(pending).toHaveLength(0);
  });

  test("a member arriving is loading from their first frame until answered", async () => {
    await render(null);
    frames = [];

    await render("admin@x.com");
    // Every frame before the answer is loading — never a "not an admin" one.
    expect(frames.every((f) => f.loading && !f.isAdmin)).toBe(true);

    await answer(true);
    expect(last()).toEqual({ loading: false, isAdmin: true });
  });

  test("one member's answer never carries over to the next account", async () => {
    await render("admin@x.com");
    await answer(true);
    frames = [];

    await render("member@x.com");
    expect(frames.every((f) => f.loading && !f.isAdmin)).toBe(true);

    await answer(false);
    expect(last()).toEqual({ loading: false, isAdmin: false });
  });

  test("a late answer for the previous member is ignored", async () => {
    await render("admin@x.com");
    await render("member@x.com");

    // The first account's check comes back after the switch.
    await answer(true);
    expect(last()).toEqual({ loading: true, isAdmin: false });

    await answer(false);
    expect(last()).toEqual({ loading: false, isAdmin: false });
  });
});
