import { useCallback, useEffect, useRef, useState } from "react";
import { errMessage } from "./errMessage";

// Shared state machine for the admin back-office CRUD pages (careers, FAQs,
// announcements, promos, retention offers). Each page differs only in its
// data type, form shape, and the exact save/delete calls — the load/refresh,
// edit-vs-new tracking, and saving/error plumbing are identical, so they live
// here.
//
// `load` and `emptyForm` are read through refs so callers can pass inline
// closures without destabilising `refresh`/`startNew` (the effect below only
// wants to run once on mount).
export function useCrudResource<T, Form>(config: {
  load: () => Promise<T[]>;
  emptyForm: () => Form;
}) {
  const loadRef = useRef(config.load);
  loadRef.current = config.load;
  const emptyFormRef = useRef(config.emptyForm);
  emptyFormRef.current = config.emptyForm;

  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(config.emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await loadRef.current());
      setListError(null);
    } catch (err) {
      setListError(errMessage(err, "Failed to load."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startNew = useCallback(() => {
    setEditingId(null);
    setForm(emptyFormRef.current());
    setFormError(null);
  }, []);

  const startEdit = useCallback((id: string, next: Form) => {
    setEditingId(id);
    setForm(next);
    setFormError(null);
  }, []);

  // Wraps a save/create call in the saving/error/refresh lifecycle. Returns
  // true on success so the caller can decide what to reset afterwards (start a
  // fresh form, show a notice, etc.).
  const runSave = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setSaving(true);
      setFormError(null);
      try {
        await action();
        await refresh();
        return true;
      } catch (err) {
        setFormError(errMessage(err, "Failed to save."));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  // Wraps a delete call, routing failures to the list error. `onGone` runs
  // after a successful delete (e.g. reset the form if the deleted row was open).
  const runRemove = useCallback(
    async (action: () => Promise<unknown>, onGone?: () => void): Promise<void> => {
      try {
        await action();
        onGone?.();
        await refresh();
      } catch (err) {
        setListError(errMessage(err, "Failed to delete."));
      }
    },
    [refresh],
  );

  return {
    items,
    setItems,
    loading,
    listError,
    setListError,
    editingId,
    form,
    setForm,
    saving,
    formError,
    setFormError,
    refresh,
    startNew,
    startEdit,
    runSave,
    runRemove,
  };
}
