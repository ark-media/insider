import type React from "react";
import { adminPrimaryButton, adminSecondaryButton } from "../../lib/admin-styles";

// Shared by the admin back-office editor forms (careers, FAQs, announcements).

// What each editor form is handed: the `useCrudResource` form state and the
// page's submit/cancel handlers.
export type AdminFormProps<Form> = {
  editing: boolean;
  form: Form;
  setForm: React.Dispatch<React.SetStateAction<Form>>;
  saving: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
};

// The foot of an editor form: the save error, then Create / Save changes, with
// Cancel only while editing an existing record. A fragment, so both nodes stay
// direct children of the form and keep its vertical spacing.
export function AdminFormActions({
  saving,
  editing,
  error,
  onCancel,
}: {
  saving: boolean;
  editing: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  return (
    <>
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
    </>
  );
}
