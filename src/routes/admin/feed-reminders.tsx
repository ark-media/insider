import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import { adminField, adminFieldLabel } from "../../lib/admin-styles";
import {
  backfillFeedActivations,
  fetchReminderConfig,
  saveReminderConfig,
  type BackfillSummary,
  type ReminderConfig,
} from "../../lib/admin";
import {
  DEFAULT_REMINDER_CONFIG,
  validateReminderConfig,
} from "../../../shared/feed-reminder";

export const Route = createFileRoute("/admin/feed-reminders")({
  component: FeedRemindersAdmin,
});

// Numeric inputs are held as strings so the field can be cleared mid-edit;
// coerced on submit and validated by the shared validator (same rules the
// server enforces).
type FormState = {
  enabled: boolean;
  delayHours: string;
  windowDays: string;
  onlyIfNoneSetUp: boolean;
};

function formFrom(c: ReminderConfig): FormState {
  return {
    enabled: c.enabled,
    delayHours: String(c.delayHours),
    windowDays: String(c.windowDays),
    onlyIfNoneSetUp: c.onlyIfNoneSetUp,
  };
}

function FeedRemindersAdmin() {
  const [form, setForm] = useState<FormState>(formFrom(DEFAULT_REMINDER_CONFIG));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setForm(formFrom(await fetchReminderConfig()));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const candidate = {
      enabled: form.enabled,
      delayHours: Number(form.delayHours),
      windowDays: Number(form.windowDays),
      onlyIfNoneSetUp: form.onlyIfNoneSetUp,
    };
    const v = validateReminderConfig(candidate);
    if (!v.ok) {
      setFormError(v.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      setForm(formFrom(await saveReminderConfig(v.value)));
      setSaved(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell active="feed-reminders" title="Feed reminders">
      <div className="max-w-[640px]">
        <p className="text-body-sm text-fg-muted">
          When a member joins but hasn't finished setting up their private
          feeds, the daily cron emails them a nudge — with the one-click Spotify
          path and a link back to their setup page. Tune who gets it and when.
          Each member is reminded at most once.
        </p>

        {loading ? (
          <p className="mt-8 text-body-sm text-fg-muted">Loading…</p>
        ) : loadError ? (
          <p className="mt-8 border border-rule bg-navy-900/60 p-4 text-body-sm text-red-300">
            {loadError}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-8 flex flex-col gap-7">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) =>
                  setForm((f) => ({ ...f, enabled: e.target.checked }))
                }
                className="mt-1 size-4 accent-cyan"
              />
              <span>
                <span className={adminFieldLabel}>Reminders enabled</span>
                <span className="mt-1 block text-body-sm text-fg-muted">
                  Turn all reminder sends on or off. When off, the cron still
                  runs but emails no one.
                </span>
              </span>
            </label>

            <div>
              <label htmlFor="delayHours" className={adminFieldLabel}>
                Delay before first reminder (hours)
              </label>
              <p className="mt-1 mb-2 text-body-sm text-fg-muted">
                How long after signing up before a member becomes eligible, so
                we don't interrupt someone mid-setup.
              </p>
              <input
                id="delayHours"
                type="number"
                min={0}
                inputMode="numeric"
                value={form.delayHours}
                onChange={(e) =>
                  setForm((f) => ({ ...f, delayHours: e.target.value }))
                }
                className={`${adminField} max-w-[160px]`}
              />
            </div>

            <div>
              <label htmlFor="windowDays" className={adminFieldLabel}>
                Reminder window (days)
              </label>
              <p className="mt-1 mb-2 text-body-sm text-fg-muted">
                Members who joined longer ago than this are left alone — so
                enabling reminders doesn't blast your whole back catalogue.
              </p>
              <input
                id="windowDays"
                type="number"
                min={1}
                inputMode="numeric"
                value={form.windowDays}
                onChange={(e) =>
                  setForm((f) => ({ ...f, windowDays: e.target.value }))
                }
                className={`${adminField} max-w-[160px]`}
              />
            </div>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={form.onlyIfNoneSetUp}
                onChange={(e) =>
                  setForm((f) => ({ ...f, onlyIfNoneSetUp: e.target.checked }))
                }
                className="mt-1 size-4 accent-cyan"
              />
              <span>
                <span className={adminFieldLabel}>
                  Only remind members who've set up nothing
                </span>
                <span className="mt-1 block text-body-sm text-fg-muted">
                  On: nudge only members with zero feeds activated. Off: also
                  nudge members who set up some but not all of their shows.
                </span>
              </span>
            </label>

            {formError ? (
              <p className="border border-rule bg-navy-900/60 p-3 text-body-sm text-red-300">
                {formError}
              </p>
            ) : null}
            {saved ? (
              <p className="text-body-sm text-cyan">Saved. The cron will use these settings on its next run.</p>
            ) : null}

            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex min-h-11 items-center bg-cyan px-6 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-fg-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {saving ? "Saving…" : "Save settings"}
              </button>
            </div>
          </form>
        )}

        <BackfillSection />
      </div>
    </AdminShell>
  );
}

// One-off (re-runnable) seeding of activation state from SC listening history,
// so existing/migrated members already show as set up and don't get reminded.
function BackfillSection() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackfillSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await backfillFeedActivations());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backfill failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="mt-14 border-t border-rule pt-10">
      <h2 className="font-display text-lg text-fg-strong">Backfill existing members</h2>
      <p className="mt-2 max-w-[560px] text-body-sm text-fg-muted">
        Members who set up their feeds before activation tracking went live have
        no record yet, so they'd show as “not set up” and could get reminded by
        mistake. This scans Supporting Cast listening history and marks any feed
        with downloads as set up. Safe to run more than once — real activation
        events always take precedence. Run this once before turning reminders on.
      </p>
      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="inline-flex min-h-11 items-center border border-cyan px-6 font-display text-[12px] font-bold uppercase tracking-button text-cyan transition hover:bg-cyan hover:text-navy disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {running ? "Backfilling…" : "Backfill from listening history"}
        </button>
      </div>
      {error ? (
        <p className="mt-4 border border-rule bg-navy-900/60 p-3 text-body-sm text-red-300">
          {error}
        </p>
      ) : null}
      {result ? (
        <p className="mt-4 text-body-sm text-cyan">
          Done — scanned {result.downloadsScanned.toLocaleString()} downloads across{" "}
          {result.pages} page{result.pages === 1 ? "" : "s"}, found {result.pairs}{" "}
          member-feed pair{result.pairs === 1 ? "" : "s"}, marked {result.inserted}{" "}
          newly set up.
        </p>
      ) : null}
    </section>
  );
}
