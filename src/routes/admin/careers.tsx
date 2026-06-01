import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import parse from "html-react-parser";
import { AdminShell } from "../../components/AdminShell";
import { RichTextEditor } from "../../components/RichTextEditor";
import {
  deleteCareer,
  listCareers,
  saveCareer,
  type CareerDraft,
} from "../../lib/admin";
import type { Career } from "../../lib/careers";
import { RICH_TEXT_CLASS, sanitizeRichPreview } from "../../lib/richTextPreview";

export const Route = createFileRoute("/admin/careers")({
  component: CareersAdmin,
});

type FormState = {
  slug: string;
  title: string;
  team: string;
  location: string;
  employmentType: string;
  summary: string;
  description: string;
  applyUrl: string;
  enabled: boolean;
  displayOrder: string; // text input; coerced to a number on submit
};

function emptyForm(): FormState {
  return {
    slug: "",
    title: "",
    team: "",
    location: "",
    employmentType: "",
    summary: "",
    description: "",
    applyUrl: "",
    enabled: true,
    displayOrder: "0",
  };
}

function formFrom(c: Career): FormState {
  return {
    slug: c.slug,
    title: c.title,
    team: c.team ?? "",
    location: c.location ?? "",
    employmentType: c.employmentType ?? "",
    summary: c.summary,
    description: c.description,
    applyUrl: c.applyUrl ?? "",
    enabled: c.enabled,
    displayOrder: String(c.displayOrder),
  };
}

function CareersAdmin() {
  const [items, setItems] = useState<Career[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listCareers());
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
  const startEdit = (c: Career) => {
    setEditingId(c.id);
    setForm(formFrom(c));
    setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.description.trim()) {
      setFormError("Description is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    const draft: CareerDraft = {
      slug: form.slug.trim(),
      title: form.title.trim(),
      team: form.team.trim(),
      location: form.location.trim(),
      employmentType: form.employmentType.trim(),
      summary: form.summary.trim(),
      description: form.description,
      applyUrl: form.applyUrl.trim(),
      enabled: form.enabled,
      displayOrder: Number(form.displayOrder) || 0,
    };
    try {
      await saveCareer(draft, editingId ?? undefined);
      await refresh();
      startNew();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Career) => {
    if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
    try {
      await deleteCareer(c.id);
      if (editingId === c.id) startNew();
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to delete.");
    }
  };

  return (
    <AdminShell active="careers" title="Careers">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <CareerForm
          editing={editingId !== null}
          form={form}
          setForm={setForm}
          saving={saving}
          error={formError}
          onSubmit={submit}
          onCancel={startNew}
        />

        <section aria-label="Existing positions">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg text-fg-strong">All positions</h2>
            <button
              type="button"
              onClick={startNew}
              className="button-text font-bold text-cyan hover:underline"
            >
              + New
            </button>
          </div>

          {loading ? (
            <p className="mt-6 text-body-sm">Loading…</p>
          ) : listError ? (
            <p className="mt-6 text-body-sm text-red-400">{listError}</p>
          ) : items.length === 0 ? (
            <p className="mt-6 text-body-sm">
              No positions yet. Create one with the form.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {items.map((c) => (
                <li
                  key={c.id}
                  className={`border p-4 ${
                    editingId === c.id ? "border-cyan" : "border-rule"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`inline-flex items-center border px-2 py-0.5 label font-bold ${
                        c.enabled
                          ? "border-cyan/60 text-cyan"
                          : "border-rule-strong text-fg-faint"
                      }`}
                    >
                      {c.enabled ? "Published" : "Hidden"}
                    </span>
                    <span className="flex gap-3 button-text font-bold">
                      <button
                        type="button"
                        onClick={() => startEdit(c)}
                        className="text-fg-strong hover:text-cyan"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(c)}
                        className="text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </span>
                  </div>

                  <h3 className="mt-3 font-display text-[16px] text-fg-strong">
                    {c.title}
                  </h3>
                  <p className="mt-1 text-body-sm">{c.summary}</p>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm">
                    <span className="text-fg-faint">/careers/{c.slug}</span>
                    {[c.team, c.location, c.employmentType]
                      .filter(Boolean)
                      .map((meta, i) => (
                        <span key={i}>{meta}</span>
                      ))}
                    {c.applyUrl ? (
                      <span className="truncate">→ {c.applyUrl}</span>
                    ) : (
                      <span className="text-amber-300">no apply URL</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

function CareerForm({
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
  const field =
    "w-full border border-rule-strong bg-navy-900 px-3 py-2 text-body text-fg-strong placeholder:text-fg-faint focus:border-cyan focus:outline-none";
  const label =
    "block button-text font-display font-bold text-fg-strong";

  return (
    <section aria-label={editing ? "Edit position" : "New position"}>
      <h2 className="font-display text-lg text-fg-strong">
        {editing ? "Edit position" : "New position"}
      </h2>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="job-title" className={label}>
            Title
          </label>
          <input
            id="job-title"
            type="text"
            required
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Senior Producer"
            className={`mt-2 ${field}`}
          />
        </div>

        <div>
          <label htmlFor="job-slug" className={label}>
            URL slug
          </label>
          <input
            id="job-slug"
            type="text"
            value={form.slug}
            onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
            placeholder="senior-producer (auto from title if blank)"
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-body-sm">
            The page lives at /careers/<span className="text-fg">{form.slug.trim() || "…"}</span>.
            Leave blank to derive it from the title.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="job-team" className={label}>
              Team
            </label>
            <input
              id="job-team"
              type="text"
              value={form.team}
              onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))}
              placeholder="Content"
              className={`mt-2 ${field}`}
            />
          </div>
          <div>
            <label htmlFor="job-location" className={label}>
              Location
            </label>
            <input
              id="job-location"
              type="text"
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              placeholder="Remote (US)"
              className={`mt-2 ${field}`}
            />
          </div>
          <div>
            <label htmlFor="job-type" className={label}>
              Type
            </label>
            <input
              id="job-type"
              type="text"
              value={form.employmentType}
              onChange={(e) =>
                setForm((f) => ({ ...f, employmentType: e.target.value }))
              }
              placeholder="Full-time"
              className={`mt-2 ${field}`}
            />
          </div>
        </div>

        <div>
          <label htmlFor="job-summary" className={label}>
            Summary
          </label>
          <textarea
            id="job-summary"
            required
            rows={2}
            value={form.summary}
            onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
            placeholder="One or two lines shown on the careers list."
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-body-sm">
            Plain text, shown on the /careers list card.
          </p>
        </div>

        <div>
          <span className={label}>Description</span>
          <div className="mt-2">
            <RichTextEditor
              ariaLabel="Job description"
              value={form.description}
              onChange={(html) =>
                setForm((f) => ({ ...f, description: html }))
              }
              minHeight="16rem"
            />
          </div>
        </div>

        {/* Live preview using the same allowlist the detail page renders. */}
        <div>
          <p className="eyebrow mb-2">Preview</p>
          <div className="rounded border border-rule bg-navy-900 p-4">
            {form.description.trim() ? (
              <div className={`text-body-lg ${RICH_TEXT_CLASS}`}>
                {parse(sanitizeRichPreview(form.description))}
              </div>
            ) : (
              <p className="text-body-sm text-fg-faint">
                The job description preview will appear here.
              </p>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="job-apply" className={label}>
            Apply URL
          </label>
          <input
            id="job-apply"
            type="text"
            value={form.applyUrl}
            onChange={(e) => setForm((f) => ({ ...f, applyUrl: e.target.value }))}
            placeholder="https://app.testgorilla.com/s/…"
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-body-sm">
            Where “Apply to this job” sends candidates (e.g. the TestGorilla
            assessment). Leave blank to fall back to the careers inbox.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="job-order" className={label}>
              Display order
            </label>
            <input
              id="job-order"
              type="number"
              value={form.displayOrder}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayOrder: e.target.value }))
              }
              className={`mt-2 ${field}`}
            />
            <p className="mt-1 text-body-sm">
              Lower numbers appear first.
            </p>
          </div>
          <label className="flex items-end gap-2 pb-2 text-body-sm text-fg">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, enabled: e.target.checked }))
              }
              className="size-4 accent-cyan"
            />
            Published (visible on the site)
          </label>
        </div>

        {error ? <p className="text-body-sm text-red-400">{error}</p> : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Create"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex min-h-11 items-center justify-center border border-rule-strong px-5 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
