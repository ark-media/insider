import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import { adminField, adminFieldLabel } from "../../lib/admin-styles";
import {
  fetchMigrationConfig,
  fetchReminderConfig,
  saveMigrationConfig,
  saveReminderConfig,
  type MigrationConfig,
  type ReminderConfig,
} from "../../lib/admin";
import {
  DEFAULT_REMINDER_CONFIG,
  validateReminderConfig,
} from "../../../shared/feed-reminder";
import {
  DEFAULT_MIGRATION_CONFIG,
  migrationSchedule,
  validateMigrationConfig,
} from "../../../shared/feed-migration";

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

  // Mount-only load. `loading` already starts true, so nothing needs to be set
  // synchronously here — state moves only once the request settles.
  useEffect(() => {
    let live = true;
    fetchReminderConfig().then(
      (config) => {
        if (!live) return;
        setForm(formFrom(config));
        setLoadError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load.");
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

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
      </div>

      <div className="mt-16 max-w-[640px] border-t border-rule pt-12">
        <MigrationCampaignForm />
      </div>
    </AdminShell>
  );
}

// ---------------------------------------------------------------------------
// The feed-migration check-in campaign — a separate campaign on a separate
// clock, so a separate form and a separate endpoint. See
// shared/feed-migration.ts for why the two don't share a config.
// ---------------------------------------------------------------------------

type MigrationFormState = {
  enabled: boolean;
  launchDate: string;
  deadlineDate: string;
  firstCheckInDays: string;
  secondCheckInDays: string;
  finalNoticeDays: string;
};

function migrationFormFrom(c: MigrationConfig): MigrationFormState {
  return {
    enabled: c.enabled,
    launchDate: c.launchDate,
    deadlineDate: c.deadlineDate,
    firstCheckInDays: String(c.firstCheckInDays),
    secondCheckInDays: String(c.secondCheckInDays),
    finalNoticeDays: String(c.finalNoticeDays),
  };
}

function migrationCandidate(f: MigrationFormState) {
  return {
    enabled: f.enabled,
    launchDate: f.launchDate,
    deadlineDate: f.deadlineDate,
    firstCheckInDays: Number(f.firstCheckInDays),
    secondCheckInDays: Number(f.secondCheckInDays),
    finalNoticeDays: Number(f.finalNoticeDays),
  };
}

const STAGE_LABEL: Record<string, string> = {
  check_in_30: "First check-in",
  check_in_60: "Second check-in",
  final: "Final notice",
};

function MigrationCampaignForm() {
  const [form, setForm] = useState<MigrationFormState>(
    migrationFormFrom(DEFAULT_MIGRATION_CONFIG),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    fetchMigrationConfig().then(
      (config) => {
        if (!live) return;
        setForm(migrationFormFrom(config));
        setLoadError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load.");
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // The whole point of the form: see which dates the three emails actually land
  // on before saving, rather than doing the arithmetic in your head.
  const preview = validateMigrationConfig(migrationCandidate(form));
  const schedule = preview.ok ? migrationSchedule(preview.value) : [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const v = validateMigrationConfig(migrationCandidate(form));
    if (!v.ok) {
      setFormError(v.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      setForm(migrationFormFrom(await saveMigrationConfig(v.value)));
      setSaved(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const dateField = (
    id: keyof MigrationFormState,
    label: string,
    help: string,
  ) => (
    <div>
      <label htmlFor={id} className={adminFieldLabel}>
        {label}
      </label>
      <p className="mt-1 mb-2 text-body-sm text-fg-muted">{help}</p>
      <input
        id={id}
        type="date"
        value={form[id] as string}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        className={`${adminField} max-w-[200px]`}
      />
    </div>
  );

  const numField = (
    id: keyof MigrationFormState,
    label: string,
    help: string,
  ) => (
    <div>
      <label htmlFor={id} className={adminFieldLabel}>
        {label}
      </label>
      <p className="mt-1 mb-2 text-body-sm text-fg-muted">{help}</p>
      <input
        id={id}
        type="number"
        min={0}
        inputMode="numeric"
        value={form[id] as string}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        className={`${adminField} max-w-[160px]`}
      />
    </div>
  );

  return (
    <>
      <h2 className="font-display text-[18px] font-bold text-fg-strong">
        Migration check-ins
      </h2>
      <p className="mt-2 text-body-sm text-fg-muted">
        A separate, escalating series for members carried over from the old Call
        Me Back feed who haven't moved to their new one — a check-in, a
        benefits-at-risk warning, then a final notice before the old feed is
        switched off. Counted from the dates below, not from when each member
        joined. Each member gets each stage at most once.
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
              <span className={adminFieldLabel}>Check-ins enabled</span>
              <span className="mt-1 block text-body-sm text-fg-muted">
                Turn the whole series on or off. Nothing sends after the
                switch-off date either way.
              </span>
            </span>
          </label>

          {dateField(
            "launchDate",
            "Launch date",
            "The day Ark+ launched. Both check-ins count from here, and it decides the audience — members whose access predates it were carried over and have a feed to move.",
          )}
          {dateField(
            "deadlineDate",
            "Old feed switch-off date",
            "The day the old Call me Back feed stops working. This date is named in all three emails.",
          )}
          {numField(
            "firstCheckInDays",
            "First check-in (days after launch)",
            "A gentle nudge: here's what you're missing, here's the link.",
          )}
          {numField(
            "secondCheckInDays",
            "Second check-in (days after launch)",
            "The escalation: names the three benefits that stop working at the deadline.",
          )}
          {numField(
            "finalNoticeDays",
            "Final notice (days before switch-off)",
            "Last call. The email counts the days itself, so this stays accurate if a run slips.",
          )}

          {schedule.length > 0 ? (
            <div className="border border-rule bg-navy-900/60 p-4">
              <p className={adminFieldLabel}>These emails will send on</p>
              <ul className="mt-2 flex flex-col gap-1">
                {schedule.map((s) => (
                  <li key={s.stage} className="text-body-sm text-fg-muted">
                    <span className="text-fg-strong">
                      {STAGE_LABEL[s.stage] ?? s.stage}
                    </span>{" "}
                    — {new Date(s.dueMs).toISOString().slice(0, 10)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {formError ? (
            <p className="border border-rule bg-navy-900/60 p-3 text-body-sm text-red-300">
              {formError}
            </p>
          ) : null}
          {saved ? (
            <p className="text-body-sm text-cyan">
              Saved. The cron will use these settings on its next run.
            </p>
          ) : null}

          <div className="flex items-center gap-4">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex min-h-11 items-center bg-cyan px-6 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-fg-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              {saving ? "Saving…" : "Save check-ins"}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
