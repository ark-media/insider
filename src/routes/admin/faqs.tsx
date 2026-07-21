import { createFileRoute } from "@tanstack/react-router";
import parse from "html-react-parser";
import { AdminShell } from "../../components/AdminShell";
import {
  AdminListPanel,
  AdminListRow,
  StatusPill,
} from "../../components/admin/AdminList";
import { RichTextEditor } from "../../components/RichTextEditor";
import {
  adminField,
  adminFieldLabel,
  adminPrimaryButton,
  adminSecondaryButton,
} from "../../lib/admin-styles";
import { deleteFaq, listFaqs, saveFaq, type FaqDraft } from "../../lib/admin";
import type { Faq } from "../../lib/faqs";
import { RICH_TEXT_CLASS, sanitizeRichPreview } from "../../lib/richTextPreview";
import { useCrudResource } from "../../lib/useCrudResource";

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
  const crud = useCrudResource<Faq, FormState>({ load: listFaqs, emptyForm });
  const { editingId, form, setForm, saving, formError, setFormError } = crud;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.answer.trim()) {
      setFormError("Answer is required.");
      return;
    }
    const draft: FaqDraft = {
      question: form.question.trim(),
      answer: form.answer,
      enabled: form.enabled,
      displayOrder: Number(form.displayOrder) || 0,
    };
    const ok = await crud.runSave(() => saveFaq(draft, editingId ?? undefined));
    if (ok) crud.startNew();
  };

  const remove = (f: Faq) => {
    if (!confirm("Delete this FAQ? This cannot be undone.")) return;
    void crud.runRemove(
      () => deleteFaq(f.id),
      () => {
        if (editingId === f.id) crud.startNew();
      },
    );
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
          onCancel={crud.startNew}
        />

        <AdminListPanel
          title="All FAQs"
          ariaLabel="Existing FAQs"
          onNew={crud.startNew}
          loading={crud.loading}
          error={crud.listError}
          items={crud.items}
          emptyText="No FAQs yet. Create one with the form."
          renderItem={(f) => (
            <AdminListRow
              key={f.id}
              active={editingId === f.id}
              pill={
                <StatusPill
                  tone={
                    f.enabled
                      ? "border-cyan/60 text-cyan"
                      : "border-rule-strong text-fg-faint"
                  }
                >
                  {f.enabled ? "Published" : "Hidden"}
                </StatusPill>
              }
              onEdit={() => crud.startEdit(f.id, formFrom(f))}
              onDelete={() => remove(f)}
            >
              <h3 className="mt-3 font-display text-[16px] text-fg-strong">
                {f.question}
              </h3>
              <div className="mt-1 line-clamp-2 text-body-sm [&_a]:underline">
                {parse(f.answer)}
              </div>

              <p className="mt-2 text-body-sm text-fg-faint">
                Order: {f.displayOrder}
              </p>
            </AdminListRow>
          )}
        />
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
  return (
    <section aria-label={editing ? "Edit FAQ" : "New FAQ"}>
      <h2 className="font-display text-lg text-fg-strong">
        {editing ? "Edit FAQ" : "New FAQ"}
      </h2>

      <form onSubmit={onSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="faq-question" className={adminFieldLabel}>
            Question
          </label>
          <textarea
            id="faq-question"
            required
            rows={2}
            value={form.question}
            onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
            placeholder="Can I still listen for free?"
            className={`mt-2 ${adminField}`}
          />
          <p className="mt-1 text-body-sm">
            Plain text — shown as the expandable row label.
          </p>
        </div>

        <div>
          <span className={adminFieldLabel}>Answer</span>
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
            <label htmlFor="faq-order" className={adminFieldLabel}>
              Display order
            </label>
            <input
              id="faq-order"
              type="number"
              value={form.displayOrder}
              onChange={(e) =>
                setForm((f) => ({ ...f, displayOrder: e.target.value }))
              }
              className={`mt-2 ${adminField}`}
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
          <button type="submit" disabled={saving} className={adminPrimaryButton}>
            {saving ? "Saving…" : editing ? "Save changes" : "Create"}
          </button>
          {editing ? (
            <button
              type="button"
              onClick={onCancel}
              className={adminSecondaryButton}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
