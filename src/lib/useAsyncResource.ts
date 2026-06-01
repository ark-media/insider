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

export function useAsyncResource<T>(
  load: () => Promise<T>,
  deps: DependencyList,
): AsyncResource<T> {
  const [state, setState] = useState<{
    status: "loading" | "error" | "ready";
    data: T | null;
  }>({ status: "loading", data: null });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ status: "loading", data: null });
    load().then(
      (data) => {
        if (live) setState({ status: "ready", data });
      },
      () => {
        if (live) setState({ status: "error", data: null });
      },
    );
    return () => {
      live = false;
    };
    // `load` is intentionally excluded — callers pass its inputs via `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { status: state.status, data: state.data, retry };
}
