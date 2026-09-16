import type React from "react";

// Presentational building blocks shared by the admin back-office list panels.
// They capture the loading/error/empty/list shell and the row chrome so the
// individual CRUD pages only describe their own row bodies.

export function AdminListPanel<T>({
  title,
  ariaLabel,
  onNew,
  loading,
  error,
  items,
  emptyText,
  renderItem,
}: {
  title: string;
  ariaLabel: string;
  onNew?: () => void;
  loading: boolean;
  error: string | null;
  items: T[];
  emptyText: string;
  renderItem: (item: T) => React.ReactNode;
}) {
  return (
    <section aria-label={ariaLabel}>
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-fg-strong">{title}</h2>
        {onNew ? (
          <button
            type="button"
            onClick={onNew}
            className="button-text font-bold text-cyan hover:underline"
          >
            + New
          </button>
        ) : null}
      </div>

      {loading ? (
        <p className="mt-6 text-body-sm">Loading…</p>
      ) : error ? (
        <p className="mt-6 text-body-sm text-red-400">{error}</p>
      ) : items.length === 0 ? (
        <p className="mt-6 text-body-sm">{emptyText}</p>
      ) : (
        <ul className="mt-4 space-y-3">{items.map(renderItem)}</ul>
      )}
    </section>
  );
}

// A list row with the shared "highlight when open in the editor" border and a
// header holding a status pill on the left and Edit/Delete on the right.
export function AdminListRow({
  active,
  pill,
  onEdit,
  onDelete,
  children,
}: {
  active: boolean;
  pill: React.ReactNode;
  onEdit: () => void;
  onDelete: () => void;
  children: React.ReactNode;
}) {
  return (
    <li className={`border p-4 ${active ? "border-cyan" : "border-rule"}`}>
      <div className="flex items-center justify-between gap-3">
        {pill}
        <span className="flex gap-3 button-text font-bold">
          <button
            type="button"
            onClick={onEdit}
            className="text-fg-strong hover:text-cyan"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="text-red-400 hover:text-red-300"
          >
            Delete
          </button>
        </span>
      </div>
      {children}
    </li>
  );
}

// The bordered status label at the top-left of a list row. `tone` supplies the
// border/text colour classes for the row's current state.
export function StatusPill({
  tone,
  children,
}: {
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 label font-bold ${tone}`}
    >
      {children}
    </span>
  );
}

// On/off pill used by the promo and retention-offer lists.
export function AdminBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center border px-2 py-0.5 ${
        on ? "border-cyan/60 text-cyan" : "border-rule-strong text-fg-muted"
      }`}
    >
      {label}
    </span>
  );
}

// Neutral outlined tag used by the promo and retention-offer lists.
export function AdminTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center border border-rule-strong px-2 py-0.5 text-fg-muted">
      {children}
    </span>
  );
}
