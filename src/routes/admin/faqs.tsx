import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import parse from "html-react-parser";
import { AdminShell } from "../../components/AdminShell";
import { RichTextEditor } from "../../components/RichTextEditor";
import { deleteFaq, listFaqs, saveFaq, type FaqDraft } from "../../lib/admin";
import type { Faq } from "../../lib/faqs";
import { RICH_TEXT_CLASS, sanitizeRichPreview } from "../../lib/richTextPreview";

export const Route = createFileRoute("/admin/faqs")({
  component: FaqsAdmin,
});

type FormState = {
  question: string;
  answer: string;
  enabled: boolean;
  displayOrder: string; // text input; coerced to a number on submit
};

function emptyForm(): FormState {
  return { question: "", answer: "", enabled: true, displayOrder: "0" };
}

function formFrom(f: Faq): FormState {
  return {
    question: f.question,
    answer: f.answer,
    enabled: f.enabled,
    displayOrder: String(f.displayOrder),
  };
}

function FaqsAdmin() {
  const [items, setItems] = useState<Faq[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listFaqs());
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
  const startEdit = (f: Faq) => {
    setEditingId(f.id);
    setForm(formFrom(f));
    setFormError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.answer.trim()) {
      setFormError("Answer is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    const draft: FaqDraft = {
      question: form.question.trim(),
      answer: form.answer,
      enabled: form.enabled,
      displayOrder: Number(form.displayOrder) || 0,
    };
    try {
      await saveFaq(draft, editingId ?? undefined);
      await refresh();
      startNew();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: Faq) => {
    if (!confirm("Delete this FAQ? This cannot be undone.")) return;
    try {
      await deleteFaq(f.id);
      if (editingId === f.id) startNew();
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to delete.");
    }
  };

  return (
    <AdminShell active="faqs" title="FAQs">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <FaqForm
          editing={editingId !== null}
          form={form}
          setForm={setForm}
          saving={saving}
          error={formError}
          onSubmit={submit}
          onCancel={startNew}
        />

        <section aria-label="Existing FAQs">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg text-fg-strong">All FAQs</h2>
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
              No FAQs yet. Create one with the form.
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {items.map((f) => (
                <li
                  key={f.id}
                  className={`border p-4 ${
                    editingId === f.id ? "border-cyan" : "border-rule"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`inline-flex items-center border px-2 py-0.5 label font-bold ${
                        f.enabled
                          ? "border-cyan/60 text-cyan"
                          : "border-rule-strong text-fg-faint"
                      }`}
                    >
                      {f.enabled ? "Published" : "Hidden"}
                    </span>
                    <span className="flex gap-3 button-text font-bold">
                      <button
                        type="button"
                        onClick={() => startEdit(f)}
                        className="text-fg-strong hover:text-cyan"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void remove(f)}
                        className="text-red-400 hover:text-red-300"
                      >
                        Delete
                      </button>
                    </span>
                  </div>

                  <h3 className="mt-3 font-display text-[16px] text-fg-strong">
                    {f.question}
                  </h3>
                  <div className="mt-1 line-clamp-2 text-body-sm [&_a]:underline">
                    {parse(f.answer)}
                  </div>

                  <p className="mt-2 text-body-sm text-fg-faint">
                    Order: {f.displayOrder}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

function FaqForm({
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
  const label = "block button-text font-display font-bold text-fg-strong";

  return (
    <section aria-label={editing ? "Edit FAQ" : "New FAQ"}>
      <h2 className="font-display text-lg text-fg-strong">
        {editing ? "Edit FAQ" : "New FAQ"}
      </h2>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="faq-question" className={label}>
            Question
          </label>
          <textarea
            id="faq-question"
            required
            rows={2}
            value={form.question}
            onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
            placeholder="Can I still listen for free?"
            className={`mt-2 ${field}`}
          />
          <p className="mt-1 text-body-sm">
            Plain text — shown as the expandable row label.
          </p>
        </div>

        <div>
          <span className={label}>Answer</span>
          <div className="mt-2">
            <RichTextEditor
              ariaLabel="FAQ answer"
              value={form.answer}
              onChange={(html) => setForm((f) => ({ ...f, answer: html }))}
              minHeight="10rem"
            />
          </div>
        </div>

        {/* Live preview using the same allowlist the FAQ section renders. */}
        <div>
          <p className="eyebrow mb-2">Preview</p>
          <div className="rounded border border-rule bg-navy-900 p-4">
            {form.answer.trim() ? (
              <div className={`text-body-sm ${RICH_TEXT_CLASS}`}>
                {parse(sanitizeRichPreview(form.answer))}
              </div>
            ) : (
              <p className="text-body-sm text-fg-faint">
                The answer preview will appear here.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="faq-order" className={label}>
              Display order
            </label>
            <input
              id="faq-order"
              type="number"
              value={form.displayOrder}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayOrder: e.target.value }))
              }
              className={`mt-2 ${field}`}
            />
            <p className="mt-1 text-body-sm">Lower numbers appear first.</p>
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
