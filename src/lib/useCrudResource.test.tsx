/// <reference types="bun" />
// Behavioural tests for the admin CRUD state machine. These need a real DOM so
// effects and cleanups actually run, so we register happy-dom here. Bun's own
// `fetch` is preserved (happy-dom would otherwise replace it) so this
// registration can't disturb the fetch-based server tests.
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
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCrudResource } from "./useCrudResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

type Item = { id: string };
type Form = { title: string };

type Crud = ReturnType<typeof useCrudResource<Item, Form>>;

// The hook is driven imperatively (refresh/startNew), so the test grabs the
// live return value rather than going through the DOM. Published from an effect
// so the probe does no work during render; `act` flushes it before the test
// reads, so the value is always the committed one.
const box: { current: Crud | null } = { current: null };

function Probe({
  load,
  emptyForm,
}: {
  load: () => Promise<Item[]>;
  emptyForm: () => Form;
}) {
  const crud = useCrudResource<Item, Form>({ load, emptyForm });
  useEffect(() => {
    box.current = crud;
  });
  return null;
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
    rerender: async (next: React.ReactElement) => {
      await act(async () => {
        root.render(next);
      });
    },
  };
}

afterEach(async () => {
  box.current = null;
  if (!mounted) return;
  const { root, container } = mounted;
  await act(async () => root.unmount());
  container.remove();
  mounted = null;
});

describe("useCrudResource", () => {
  test("loads on mount and clears the loading flag", async () => {
    const d = deferred<Item[]>();
    await render(<Probe load={() => d.promise} emptyForm={() => ({ title: "" })} />);

    expect(box.current?.loading).toBe(true);
    expect(box.current?.items).toEqual([]);

    await act(async () => {
      d.resolve([{ id: "a" }]);
    });
    expect(box.current?.loading).toBe(false);
    expect(box.current?.items).toEqual([{ id: "a" }]);
    expect(box.current?.listError).toBeNull();
  });

  test("surfaces a failed load as listError and stops loading", async () => {
    const d = deferred<Item[]>();
    await render(<Probe load={() => d.promise} emptyForm={() => ({ title: "" })} />);

    await act(async () => {
      d.reject(new Error("nope"));
    });
    expect(box.current?.loading).toBe(false);
    expect(box.current?.listError).toBe("nope");
  });

  test("refresh() re-enters loading and replaces the items", async () => {
    const first = deferred<Item[]>();
    const second = deferred<Item[]>();
    let call = 0;
    const load = () => (++call === 1 ? first.promise : second.promise);

    await render(<Probe load={load} emptyForm={() => ({ title: "" })} />);
    await act(async () => {
      first.resolve([{ id: "a" }]);
    });
    expect(box.current?.loading).toBe(false);

    let done: Promise<void>;
    await act(async () => {
      done = box.current!.refresh();
    });
    // Unlike the mount load, an explicit refresh does show the loading state.
    expect(box.current?.loading).toBe(true);

    await act(async () => {
      second.resolve([{ id: "b" }]);
      await done;
    });
    expect(box.current?.loading).toBe(false);
    expect(box.current?.items).toEqual([{ id: "b" }]);
    expect(call).toBe(2);
  });

  // `load` is held in a ref so callers can pass an inline closure without
  // destabilising refresh. That ref is now synced in an effect rather than
  // during render, so this guards that a later refresh still sees the newest
  // closure.
  test("refresh() calls the most recently rendered load closure", async () => {
    const first = deferred<Item[]>();
    const second = deferred<Item[]>();
    let usedSecond = false;

    const { rerender } = await render(
      <Probe load={() => first.promise} emptyForm={() => ({ title: "" })} />,
    );
    await act(async () => {
      first.resolve([{ id: "a" }]);
    });

    await rerender(
      <Probe
        load={() => {
          usedSecond = true;
          return second.promise;
        }}
        emptyForm={() => ({ title: "" })}
      />,
    );

    await act(async () => {
      void box.current!.refresh();
    });
    expect(usedSecond).toBe(true);

    await act(async () => {
      second.resolve([{ id: "b" }]);
    });
    expect(box.current?.items).toEqual([{ id: "b" }]);
  });

  // Same ref-sync concern, on the other ref the hook keeps.
  test("startNew() uses the most recently rendered emptyForm", async () => {
    const d = deferred<Item[]>();
    const { rerender } = await render(
      <Probe load={() => d.promise} emptyForm={() => ({ title: "first" })} />,
    );
    await act(async () => {
      d.resolve([]);
    });
    // Seeded from the mount-time emptyForm.
    expect(box.current?.form).toEqual({ title: "first" });

    await rerender(
      <Probe load={() => d.promise} emptyForm={() => ({ title: "second" })} />,
    );
    await act(async () => {
      box.current!.startNew();
    });
    expect(box.current?.form).toEqual({ title: "second" });
    expect(box.current?.editingId).toBeNull();
  });

  test("startEdit() records the row and its form, and runSave clears it", async () => {
    const d = deferred<Item[]>();
    await render(<Probe load={() => d.promise} emptyForm={() => ({ title: "" })} />);
    await act(async () => {
      d.resolve([{ id: "a" }]);
    });

    await act(async () => {
      box.current!.startEdit("a", { title: "editing" });
    });
    expect(box.current?.editingId).toBe("a");
    expect(box.current?.form).toEqual({ title: "editing" });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await box.current!.runSave(async () => {});
    });
    expect(ok).toBe(true);
    expect(box.current?.saving).toBe(false);
    expect(box.current?.formError).toBeNull();
  });

  test("runSave reports failure through formError without throwing", async () => {
    const d = deferred<Item[]>();
    await render(<Probe load={() => d.promise} emptyForm={() => ({ title: "" })} />);
    await act(async () => {
      d.resolve([]);
    });

    let ok: boolean | undefined;
    await act(async () => {
      ok = await box.current!.runSave(async () => {
        throw new Error("save failed");
      });
    });
    expect(ok).toBe(false);
    expect(box.current?.formError).toBe("save failed");
    expect(box.current?.saving).toBe(false);
  });

  // The load guard added alongside the effect rewrite: a response that lands
  // after the component is gone must not attempt a state update.
  test("a response arriving after unmount is dropped", async () => {
    const d = deferred<Item[]>();
    await render(<Probe load={() => d.promise} emptyForm={() => ({ title: "" })} />);

    const { root, container } = mounted!;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;

    const settled = box.current;
    await act(async () => {
      d.resolve([{ id: "late" }]);
    });
    // State is frozen at its pre-unmount value; nothing was written after.
    expect(settled?.items).toEqual([]);
    expect(settled?.loading).toBe(true);
  });
});
