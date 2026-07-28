import { useCallback, useEffect, useState, type DependencyList } from "react";

/**
 * Three-state async fetch hook. Replaces the ad-hoc
 * `useState<T | null>` + `useEffect` + `live` flag pattern that conflated
 * "loading" with "failed" (a rejected fetch left the UI stuck on null forever).
 *
 * `load` must REJECT on failure for the error state to trigger — fetchers that
 * swallow errors into null/[] will only ever report "ready". Pass `load`'s
 * captured inputs in `deps` (not `load` itself), mirroring the inline-closure
 * convention the call sites already use. `retry()` re-runs `load`.
 */
export type AsyncResource<T> = {
  status: "loading" | "error" | "ready";
  data: T | null;
  retry: () => void;
};

function sameKey(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => Object.is(value, b[i]));
}

export function useAsyncResource<T>(
  load: () => Promise<T>,
  deps: DependencyList,
): AsyncResource<T> {
  const [nonce, setNonce] = useState(0);

  // Identifies the current request. Settled state carries the key it was
  // fetched for, so a stale result is recognised by comparison rather than by
  // resetting state from inside the effect.
  const key: DependencyList = [...deps, nonce];

  const [settled, setSettled] = useState<{
    status: "error" | "ready";
    data: T | null;
    key: DependencyList;
  } | null>(null);

  useEffect(() => {
    let live = true;
    load().then(
      (data) => {
        if (live) setSettled({ status: "ready", data, key });
      },
      () => {
        if (live) setSettled({ status: "error", data: null, key });
      },
    );
    return () => {
      live = false;
    };
    // `load` is intentionally excluded — callers pass its inputs via `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, key);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  // Anything settled under a previous key belongs to a superseded request, so
  // a deps change (or retry) reads as "loading" on the very next render.
  const fresh = settled && sameKey(settled.key, key) ? settled : null;

  return {
    status: fresh ? fresh.status : "loading",
    data: fresh ? fresh.data : null,
    retry,
  };
}
