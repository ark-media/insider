/// <reference types="bun" />
// Behavioural tests for the async-fetch hook: these need a real DOM so effects
// and cleanups actually run, so we register happy-dom here. Bun's own `fetch`
// is preserved (happy-dom would otherwise replace it) so this registration
// can't disturb the fetch-based server tests.
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

import { afterEach, describe, expect, test } from "bun:test";
import { act, type DependencyList } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAsyncResource } from "./useAsyncResource";

// A promise whose settlement the test drives, so we can observe the states
// between "requested" and "answered" rather than racing them.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing in these tests inspects a rejection that the hook already handled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function Probe({
  load,
  deps,
}: {
  load: () => Promise<string>;
  deps: DependencyList;
}) {
  const { status, data, retry } = useAsyncResource(load, deps);
  return (
    <div>
      <span id="status">{status}</span>
      <span id="data">{data ?? "-"}</span>
      <button type="button" id="retry" onClick={retry}>
        retry
      </button>
    </div>
  );
}

let mounted: { root: Root; container: HTMLElement } | null = null;

async function render(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
  });
  mounted = { root, container };
  return {
    container,
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

const read = (c: HTMLElement, id: string) =>
  c.querySelector(`#${id}`)?.textContent;

afterEach(async () => {
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

describe("useAsyncResource", () => {
  test("starts loading and reports the resolved value", async () => {
    const d = deferred<string>();
    const { container } = await render(
      <Probe load={() => d.promise} deps={[]} />,
    );

    expect(read(container, "status")).toBe("loading");
    expect(read(container, "data")).toBe("-");

    await act(async () => {
      d.resolve("first");
    });
    expect(read(container, "status")).toBe("ready");
    expect(read(container, "data")).toBe("first");
  });

  test("reports error and no data when the load rejects", async () => {
    const d = deferred<string>();
    const { container } = await render(
      <Probe load={() => d.promise} deps={[]} />,
    );

    await act(async () => {
      d.reject(new Error("boom"));
    });
    expect(read(container, "status")).toBe("error");
    expect(read(container, "data")).toBe("-");
  });

  // The regression this hook was rewritten for: a deps change must read as
  // loading straight away rather than briefly showing the previous key's data.
  test("returns to loading immediately when deps change", async () => {
    const first = deferred<string>();
    const second = deferred<string>();

    const { container, rerender } = await render(
      <Probe load={() => first.promise} deps={["a"]} />,
    );
    await act(async () => {
      first.resolve("value-a");
    });
    expect(read(container, "status")).toBe("ready");
    expect(read(container, "data")).toBe("value-a");

    await rerender(<Probe load={() => second.promise} deps={["b"]} />);
    // Still in flight — the old value must not be visible under the new key.
    expect(read(container, "status")).toBe("loading");
    expect(read(container, "data")).toBe("-");

    await act(async () => {
      second.resolve("value-b");
    });
    expect(read(container, "status")).toBe("ready");
    expect(read(container, "data")).toBe("value-b");
  });

  test("retry() refetches and shows loading while it is in flight", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const load = () => (++call === 1 ? first.promise : second.promise);

    const { container } = await render(<Probe load={load} deps={[]} />);
    await act(async () => {
      first.resolve("one");
    });
    expect(read(container, "status")).toBe("ready");

    await act(async () => {
      container.querySelector<HTMLButtonElement>("#retry")?.click();
    });
    expect(read(container, "status")).toBe("loading");
    expect(read(container, "data")).toBe("-");

    await act(async () => {
      second.resolve("two");
    });
    expect(read(container, "data")).toBe("two");
    expect(call).toBe(2);
  });

  test("a superseded response cannot overwrite the current one", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();

    const { container, rerender } = await render(
      <Probe load={() => slow.promise} deps={["a"]} />,
    );
    await rerender(<Probe load={() => fast.promise} deps={["b"]} />);

    await act(async () => {
      fast.resolve("value-b");
    });
    expect(read(container, "data")).toBe("value-b");

    // The abandoned request for deps ["a"] lands late and must be dropped.
    await act(async () => {
      slow.resolve("value-a");
    });
    expect(read(container, "status")).toBe("ready");
    expect(read(container, "data")).toBe("value-b");
  });
});
