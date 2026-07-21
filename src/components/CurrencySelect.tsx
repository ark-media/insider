import { useEffect, useId, useRef, useState } from "react";

// A compact currency picker. We can't use a native <select> here: its popup is
// rendered and sized by the OS/browser, so a 40-item list overflows the viewport
// with no way to cap its height. This is a custom listbox — a trigger button
// plus a fixed-height, inner-scrolling panel — so the list stays inside the
// modal. Keyboard + ARIA are wired to the listbox pattern (arrow keys, Home/End,
// Enter/Space, Escape).
export function CurrencySelect({
  value,
  options,
  disabled,
  onChange,
}: {
  value: string;
  options: string[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(0, options.indexOf(value)),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const baseId = useId();
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // While open: focus the list so it takes keyboard input, and close on any
  // pointer press outside the widget. (The active option is synced to the
  // current value in openMenu, not here, to avoid a setState-in-effect.)
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Keep the active option scrolled into view as it moves.
  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const openMenu = () => {
    setActiveIndex(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const commit = (index: number) => {
    const next = options[index];
    if (next) onChange(next);
    close(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        // Stop the modal's window-level Escape handler from closing the whole
        // modal — Escape here just dismisses the dropdown.
        e.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        e.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(activeIndex);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Currency: ${value.toUpperCase()}`}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className="inline-flex min-w-16 items-center justify-between gap-1.5 border border-rule-strong bg-transparent px-2 py-1 text-body-sm text-fg-strong outline-none transition focus:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-50"
      >
        <span className="tabular-nums">{value.toUpperCase()}</span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-fg-faint transition ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      {open ? (
        <ul
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={onListKeyDown}
          className="absolute right-0 z-20 mt-1 max-h-64 w-28 overflow-y-auto border border-rule-strong bg-navy-700 py-1 shadow-2xl outline-none"
        >
          {options.map((c, i) => {
            const selected = c === value;
            const active = i === activeIndex;
            return (
              <li
                key={c}
                id={optionId(i)}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                role="option"
                aria-selected={selected}
                onClick={() => commit(i)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`cursor-pointer px-3 py-2 text-body-sm tabular-nums ${
                  active ? "bg-cyan text-navy" : "text-fg-strong"
                } ${selected && !active ? "font-semibold text-cyan" : ""}`}
              >
                {c.toUpperCase()}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
