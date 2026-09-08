import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { beaconSupportLog, flushSupportLog } from "../../lib/support/session";

// The panel body pulls in the search index, the curated tables and
// html-react-parser. The launcher renders on every page and most visits never
// open it, so none of that belongs in the initial bundle.
const SupportPanel = lazy(() =>
  import("./SupportPanel").then((m) => ({ default: m.SupportPanel })),
);

/**
 * The floating help launcher.
 *
 * Deliberately NOT a modal. `Modal.tsx` and the masthead's mobile drawer both
 * write `document.body.style.overflow` and restore it from their own saved
 * value; a third writer would fight them for it. So this is a disclosure —
 * `aria-expanded`/`aria-controls` on the launcher, no focus trap, no scroll
 * lock — and it sits at z-45: above the masthead (20/30) and the announcement
 * banner (40), below the checkout modal and toasts (50) and the nav drawer
 * (55/60), so those correctly cover it rather than the reverse.
 */
export function SupportWidget() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  // Once opened, the panel stays mounted: it holds the fetched FAQ index and
  // the member's place in it, and reopening should not re-fetch or forget.
  const [everOpened, setEverOpened] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes, from anywhere — the panel is non-modal, so the key may well
  // be pressed while focus is still out on the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Move focus into the panel on open and hand it back to the launcher on
  // close — the two halves of a disclosure that a keyboard user needs, without
  // the trap that would make this behave like a modal.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) panelRef.current?.focus();
    else if (!open && wasOpen.current) launcherRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // A session that ends with the tab closing is exactly the session worth
  // having logged. `fetch` is abandoned when the document goes away; a beacon
  // is queued by the browser and survives it.
  useEffect(() => {
    if (!everOpened) return;
    const onHide = () => beaconSupportLog();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [everOpened]);

  const close = () => {
    setOpen(false);
    void flushSupportLog();
  };

  // Staff-facing. The back office has its own navigation and none of these
  // answers apply to it.
  if (pathname.startsWith("/admin")) return null;

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => {
          setEverOpened(true);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-controls="support-panel"
        className="fixed bottom-4 right-4 z-[45] inline-flex min-h-12 items-center gap-2 border border-cyan bg-cyan px-4 button-text text-navy shadow-2xl transition hover:bg-navy-900 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan motion-reduce:transition-none"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="square"
        >
          {open ? (
            <path d="M3 3l10 10M13 3L3 13" />
          ) : (
            <>
              <path d="M5.5 5.8a2.6 2.6 0 1 1 3 2.6v1.4" />
              <path d="M8.5 12.2h-1v-1h1z" fill="currentColor" />
            </>
          )}
        </svg>
        {open ? "Close" : "Help"}
      </button>

      {everOpened ? (
        <div
          id="support-panel"
          ref={panelRef}
          role="dialog"
          aria-label="Help"
          tabIndex={-1}
          inert={!open}
          className={`fixed bottom-20 left-3 right-3 z-[45] flex max-h-[min(70dvh,560px)] flex-col border border-rule bg-navy-900 shadow-2xl outline-none transition duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none sm:left-auto sm:right-4 sm:w-[380px] ${
            open
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-3 opacity-0"
          }`}
        >
          {/* Cyan accent rail — the brand hairline, as on Toast. */}
          <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-cyan" />

          <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-4">
            <div>
              <h2 className="font-display text-[18px] leading-none text-fg-strong">
                Help.
              </h2>
              <p className="mt-1.5 text-body-sm text-fg-faint">
                Answers to the usual questions.
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close help"
              className="-mr-1 -mt-1 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center text-fg-faint transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="square"
              >
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>

          <Suspense
            fallback={<p className="px-4 pb-4 text-body-sm text-fg-faint">Loading…</p>}
          >
            <SupportPanel onClose={close} />
          </Suspense>
        </div>
      ) : null}
    </>
  );
}
