import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  className,
  labelledBy,
  describedBy,
  scrollBody = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Cap the panel to the viewport on sm+ and scroll its body instead of the
   *  whole overlay, so the close button stays reachable on tall content. */
  scrollBody?: boolean;
  children: React.ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stableClose = useCallback(() => onCloseRef.current(), []);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement;

    // Lock background scroll while the dialog is open so scrolling inside the
    // modal can't bleed into the page behind it.
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stableClose();
        return;
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusable =
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKey);

    // Focus the first focusable element inside the panel
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevBodyOverflow;
      if (previousFocusRef.current instanceof HTMLElement) {
        previousFocusRef.current.focus();
      }
    };
  }, [open, stableClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy-900/90 py-4 sm:items-center sm:py-8"
      onClick={stableClose}
    >
      <div
        ref={panelRef}
        className={`relative mx-3 my-auto w-full border border-rule bg-navy-900 p-6 text-fg-strong shadow-2xl sm:mx-4 sm:p-8 ${
          scrollBody ? "flex flex-col sm:max-h-[calc(100dvh-4rem)]" : ""
        } ${className ?? ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={stableClose}
          aria-label="Close"
          className="absolute right-2 top-2 inline-flex min-h-11 min-w-11 items-center justify-center text-fg-faint transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          <svg
            width="16"
            height="16"
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
        {scrollBody ? (
          // Negative margins pull the scroll area out to the panel edges so the
          // scrollbar hugs the border rather than floating inside the padding.
          <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 sm:-mx-8 sm:px-8">
            {children}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
