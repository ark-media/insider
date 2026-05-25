import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import parse from "html-react-parser";
import { AdminShell } from "../../components/AdminShell";
import {
  deleteAnnouncement,
  listAnnouncements,
  saveAnnouncement,
  type AnnouncementDraft,
} from "../../lib/admin";
import { sanitizeInlinePreview } from "../../lib/announcements";
import type { Announcement } from "../../lib/announcements";
import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  browserTimeZone,
  describeInstant,
  utcToZonedWallClock,
  zonedWallClockToUtc,
} from "../../lib/datetime";

export const Route = createFileRoute("/admin/announcements")({
  component: AnnouncementsAdmin,
});

const DEFAULT_BAR = "#4a9fe8";
const DEFAULT_TEXT = "#0a2540";

// Zones offered in the dropdown: the curated list, plus the admin's own browser
// zone if it isn't already there (so a traveling/remote admin can pick it).
const TIME_ZONE_OPTIONS = (() => {
  const tz = browserTimeZone();
  if (COMMON_TIME_ZONES.some((z) => z.value === tz)) return COMMON_TIME_ZONES;
  return [{ value: tz, label: `${tz} (your timezone)` }, ...COMMON_TIME_ZONES];
})();

type FormState = {
  body: string;
  actionUrl: string;
  barColor: string;
  textColor: string;
  dismissible: boolean;
  enabled: boolean;
  timeZone: string; // IANA zone the wall-clock fields below are entered in
  startsAt: string; // datetime-local (wall clock in timeZone)
  endsAt: string; // datetime-local (wall clock in timeZone)
};

function emptyForm(): FormState {
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return {
    body: "",
    actionUrl: "",
    barColor: DEFAULT_BAR,
    textColor: DEFAULT_TEXT,
    dismissible: true,
    enabled: true,
    timeZone: DEFAULT_TIME_ZONE,
    startsAt: utcToZonedWallClock(now.toISOString(), DEFAULT_TIME_ZONE),
    endsAt: utcToZonedWallClock(end.toISOString(), DEFAULT_TIME_ZONE),
  };
}

function formFrom(a: Announcement): FormState {
  // The stored window is an absolute instant; we render it in the default zone
  // (the original entry zone isn't persisted — only the instant is).
  return {
    body: a.body,
    actionUrl: a.actionUrl ?? "",
    barColor: a.barColor,
    textColor: a.textColor,
    dismissible: a.dismissible,
    enabled: a.enabled,
    timeZone: DEFAULT_TIME_ZONE,
    startsAt: utcToZonedWallClock(a.startsAt, DEFAULT_TIME_ZONE),
    endsAt: utcToZonedWallClock(a.endsAt, DEFAULT_TIME_ZONE),
  };
}

type Status = "live" | "scheduled" | "ended" | "disabled";
function statusOf(a: Announcement): Status {
  if (!a.enabled) return "disabled";
  const now = Date.now();
  if (now < Date.parse(a.startsAt)) return "scheduled";
  if (now > Date.parse(a.endsAt)) return "ended";
  return "live";
}
const STATUS_STYLE: Record<Status, string> = {
  live: "border-cyan/60 text-cyan",
  scheduled: "border-amber-400/60 text-amber-300",
  ended: "border-rule-strong text-fg-muted",
  disabled: "border-rule-strong text-fg-faint",
};

function AnnouncementsAdmin() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listAnnouncements());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError(null);
  };
  const startEdit = (a: Announcement) => {
    setEditingId(a.id);
    setForm(formFrom(a));
    setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const draft: AnnouncementDraft = {
      body: form.body,
      actionUrl: form.actionUrl.trim(),
      barColor: form.barColor,
      textColor: form.textColor,
      dismissible: form.dismissible,
      enabled: form.enabled,
      startsAt: zonedWallClockToUtc(form.startsAt, form.timeZone),
      endsAt: zonedWallClockToUtc(form.endsAt, form.timeZone),
    };
    try {
      await saveAnnouncement(draft, editingId ?? undefined);
      await refresh();
      startNew();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (a: Announcement) => {
    if (!confirm("Delete this announcement? This cannot be undone.")) return;
    try {
      await deleteAnnouncement(a.id);
      if (editingId === a.id) startNew();
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to delete.");
    }
  };

  return (
    <AdminShell active="announcements" title="Announcements">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <AnnouncementForm
          editing={editingId !== null}
          form={form}
          setForm={setForm}
          saving={saving}
          error={formError}
          onSubmit={submit}
          onCancel={startNew}
        />

        <section aria-label="Existing announcements">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg text-fg-strong">All announcements</h2>
            <button
              type="button"
              onClick={startNew}
              className="text-[12px] font-bold uppercase tracking-button text-cyan hover:underline"
            >
              + New
            </button>
          </div>

          {loading ? (
            <p className="mt-6 text-[14px] text-fg-muted">Loading…</p>
          ) : listError ? (
            <p className="mt-6 text-[14px] text-red-400">{listError}</p>
          ) : items.length === 0 ? (
            <p className="mt-6 text-[14px] text-fg-muted">
              No announcements yet. Create one with the form.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {items.map((a) => {
                const status = statusOf(a);
                return (
                  <li
                    key={a.id}
                    className={`border p-4 ${
                      editingId === a.id ? "border-cyan" : "border-rule"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span
                        className={`inline-flex items-center border px-2 py-0.5 text-[10px] font-bold uppercase tracking-button ${STATUS_STYLE[status]}`}
                      >
                        {status}
                      </span>
                      <span className="flex gap-3 text-[12px] font-bold uppercase tracking-button">
                        <button
                          type="button"
                          onClick={() => startEdit(a)}
                          className="text-fg-strong hover:text-cyan"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(a)}
                          className="text-red-400 hover:text-red-300"
                        >
                          Delete
                        </button>
                      </span>
                    </div>

                    <div className="mt-3 truncate text-[13px] text-fg">
                      {parse(a.body)}
                    </div>

                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-muted">
                      <span>
                        {new Date(a.startsAt).toLocaleString()} →{" "}
                        {new Date(a.endsAt).toLocaleString()}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span
                          aria-hidden="true"
                          className="inline-block size-3 rounded-sm border border-rule"
                          style={{ backgroundColor: a.barColor }}
                        />
                        {a.barColor}
                      </span>
                      {a.actionUrl ? <span className="truncate">{a.actionUrl}</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

// Confirms the absolute window the entered wall-clock times resolve to, shown
// in the admin's own browser timezone so they can sanity-check across zones.
// Only renders the cross-check when the chosen zone differs from the browser's.
function ScheduleHint({
  startsAt,
  endsAt,
  timeZone,
}: {
  startsAt: string;
  endsAt: string;
  timeZone: string;
}) {
  const localZone = browserTimeZone();
  if (timeZone === localZone) return null;
  let startIso: string;
  let endIso: string;
  try {
    startIso = zonedWallClockToUtc(startsAt, timeZone);
    endIso = zonedWallClockToUtc(endsAt, timeZone);
  } catch {
    return null;
  }
  return (
    <p className="text-[11px] text-fg-muted">
      In your timezone ({localZone}): {describeInstant(startIso, localZone)} →{" "}
      {describeInstant(endIso, localZone)}
    </p>
  );
}

const FORMAT_BUTTONS: { tag: string; label: string }[] = [
  { tag: "b", label: "B" },
  { tag: "i", label: "I" },
  { tag: "u", label: "U" },
  { tag: "s", label: "S" },
  { tag: "a", label: "Link" },
];

function AnnouncementForm({
  editing,
  form,
  setForm,
  saving,
  error,
  onSubmit,
  onCancel,
}: {
  editing: boolean;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  saving: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Wrap the current textarea selection in an inline tag (the same B/I/U/S a
  // supporting-cast editor offers), then restore the selection.
  const applyTag = (tag: string) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: start, selectionEnd: end } = ta;
    const selected = form.body.slice(start, end);
    const open = tag === "a" ? '<a href="https://">' : `<${tag}>`;
    const close = `</${tag}>`;
    const next = form.body.slice(0, start) + open + selected + close + form.body.slice(end);
    setForm((f) => ({ ...f, body: next }));
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + open.length;
      ta.setSelectionRange(pos, pos + selected.length);
    });
  };

  const field = "w-full border border-rule-strong bg-navy-900 px-3 py-2 text-[14px] text-fg-strong placeholder:text-fg-faint focus:border-cyan focus:outline-none";
  const label = "block font-display text-[12px] font-bold uppercase tracking-button text-fg-strong";

  return (
    <section aria-label={editing ? "Edit announcement" : "New announcement"}>
      <h2 className="font-display text-lg text-fg-strong">
        {editing ? "Edit announcement" : "New announcement"}
      </h2>

      {/* Live preview using the same renderer as the real banner. */}
      <div className="mt-4">
        <p className="eyebrow mb-2">Preview</p>
        <div
          className="flex items-center justify-center px-8 py-2.5 text-center text-[13px] font-medium [&_a]:underline"
          style={{ backgroundColor: form.barColor, color: form.textColor }}
        >
          {form.body.trim() ? parse(sanitizeInlinePreview(form.body)) : <span className="opacity-60">Your announcement text…</span>}
        </div>
      </div>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="ann-body" className={label}>
            Body
          </label>
          <div className="mt-2 flex gap-1">
            {FORMAT_BUTTONS.map((b) => (
              <button
                key={b.tag}
                type="button"
                onClick={() => applyTag(b.tag)}
                className="inline-flex h-8 min-w-8 items-center justify-center border border-rule-strong px-2 text-[12px] text-fg-strong transition hover:border-cyan hover:text-cyan"
              >
                {b.label}
              </button>
            ))}
          </div>
          <textarea
            id="ann-body"
            ref={bodyRef}
            required
            rows={3}
            value={form.body}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
            placeholder="🎉 Limited time offer! Use code SPRING60 …"
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-[11px] text-fg-muted">
            Inline formatting only (bold, italic, underline, strike, links).
            Anything else is stripped on save.
          </p>
        </div>

        <div>
          <label htmlFor="ann-url" className={label}>
            Action URL
          </label>
          <input
            id="ann-url"
            type="text"
            value={form.actionUrl}
            onChange={(e) => setForm((f) => ({ ...f, actionUrl: e.target.value }))}
            placeholder="/plus  or  https://…"
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-[11px] text-fg-muted">
            Where the bar links when clicked. Leave blank for none.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="ann-bar" className={label}>
              Bar color
            </label>
            <input
              id="ann-bar"
              type="color"
              value={form.barColor}
              onChange={(e) => setForm((f) => ({ ...f, barColor: e.target.value }))}
              className="mt-2 h-10 w-full border border-rule-strong bg-navy-900"
            />
          </div>
          <div>
            <label htmlFor="ann-text" className={label}>
              Text color
            </label>
            <input
              id="ann-text"
              type="color"
              value={form.textColor}
              onChange={(e) => setForm((f) => ({ ...f, textColor: e.target.value }))}
              className="mt-2 h-10 w-full border border-rule-strong bg-navy-900"
            />
          </div>
        </div>

        <div>
          <label htmlFor="ann-tz" className={label}>
            Timezone
          </label>
          <select
            id="ann-tz"
            value={form.timeZone}
            onChange={(e) => setForm((f) => ({ ...f, timeZone: e.target.value }))}
            className={`mt-2 ${field}`}
          >
            {TIME_ZONE_OPTIONS.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-fg-muted">
            The start and end times below are read in this timezone.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="ann-start" className={label}>
              Start
            </label>
            <input
              id="ann-start"
              type="datetime-local"
              required
              value={form.startsAt}
              onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
              className={`mt-2 ${field}`}
            />
          </div>
          <div>
            <label htmlFor="ann-end" className={label}>
              End
            </label>
            <input
              id="ann-end"
              type="datetime-local"
              required
              value={form.endsAt}
              onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
              className={`mt-2 ${field}`}
            />
          </div>
        </div>

        <ScheduleHint
          startsAt={form.startsAt}
          endsAt={form.endsAt}
          timeZone={form.timeZone}
        />

        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-[14px] text-fg">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              className="size-4 accent-cyan"
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-[14px] text-fg">
            <input
              type="checkbox"
              checked={form.dismissible}
              onChange={(e) => setForm((f) => ({ ...f, dismissible: e.target.checked }))}
              className="size-4 accent-cyan"
            />
            Dismissible
          </label>
        </div>

        {error ? <p className="text-[13px] text-red-400">{error}</p> : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Create"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-11 items-center justify-center border border-rule-strong px-5 font-display text-[12px] font-bold uppercase tracking-button text-fg-strong transition hover:border-cyan hover:text-cyan"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
