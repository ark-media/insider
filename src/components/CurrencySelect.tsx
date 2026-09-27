import { useEffect, useId, useRef, useState } from "react";

// A compact currency picker. We can't use a native <select> here: its popup is
// rendered and sized by the OS/browser, so a 40-item list overflows the viewport
// with no way to cap its height. This is a custom listbox — a trigger button
// plus a fixed-height, inner-scrolling panel — so the list stays inside the
// modal. Keyboard + ARIA are wired to the listbox pattern (arrow keys, Home/End,
// Enter/Space, Escape, and type-ahead — typing "u", "us" or "euro" jumps to the
// matching currency, from the closed trigger as well as the open list).

// "GBP" alone is read letter by letter by screen readers, so each option's
// accessible name also carries the currency's English name.
const currencyNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "currency" });
  } catch {
    return null;
  }
})();

function currencyName(code: string): string | undefined {
  try {
    const name = currencyNames?.of(code.toUpperCase());
    return name && name.toUpperCase() !== code.toUpperCase() ? name : undefined;
  } catch {
    return undefined;
  }
}

// How long a pause ends a type-ahead run (the APG listbox's usual ~500ms).
const TYPEAHEAD_RESET_MS = 500;

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
  const typeahead = useRef({ query: "", at: 0 });
  const baseId = useId();
  const listId = `${baseId}-list`;
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

  const openMenu = (index = Math.max(0, options.indexOf(value))) => {
    setActiveIndex(index);
    setOpen(true);
  };

  // Type-ahead: accumulate keystrokes typed within TYPEAHEAD_RESET_MS and jump
  // to the first option whose code or name starts with them. A repeated single
  // letter ("s", "s", "s") cycles through the matches instead, as native
  // selects do. Returns the index to move to, or null for no match.
  const matchTypeahead = (e: React.KeyboardEvent, from: number): number | null => {
    const now = e.timeStamp;
    const t = typeahead.current;
    const char = e.key.toLowerCase();
    t.query = now - t.at > TYPEAHEAD_RESET_MS ? char : t.query + char;
    t.at = now;
    const cycling = t.query.length > 1 && [...t.query].every((c) => c === char);
    const query = cycling ? char : t.query;
    // A fresh or cycling search starts after the current option so repeated
    // presses advance; an extended query ("u" → "us") re-checks the current one.
    const start = query.length === 1 ? from + 1 : from;
    for (let n = 0; n < options.length; n++) {
      const i = (start + n) % options.length;
      const code = options[i].toLowerCase();
      const name = currencyName(options[i])?.toLowerCase() ?? "";
      if (code.startsWith(query) || name.startsWith(query)) return i;
    }
    return null;
  };

  const isTypeaheadKey = (e: React.KeyboardEvent) =>
    e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;

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
    } else if (isTypeaheadKey(e)) {
      e.preventDefault();
      const current = Math.max(0, options.indexOf(value));
      openMenu(matchTypeahead(e, current) ?? current);
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
      default:
        if (isTypeaheadKey(e)) {
          e.preventDefault();
          const match = matchTypeahead(e, activeIndex);
          if (match !== null) setActiveIndex(match);
        }
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
        aria-controls={open ? listId : undefined}
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
          id={listId}
          role="listbox"
          aria-label="Currency"
          tabIndex={-1}
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={onListKeyDown}
          className="absolute right-0 z-20 mt-1 max-h-64 w-28 overflow-y-auto border border-rule-strong bg-navy-700 py-1 shadow-2xl outline-none"
        >
          {options.map((c, i) => {
            const selected = c === value;
            const active = i === activeIndex;
            const name = currencyName(c);
            return (
              <li
                key={c}
                id={optionId(i)}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                role="option"
                aria-selected={selected}
                aria-label={name ? `${c.toUpperCase()}, ${name}` : undefined}
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
