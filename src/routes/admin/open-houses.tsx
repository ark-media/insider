import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AdminShell } from "../../components/AdminShell";
import {
  adminField,
  adminFieldLabel,
  adminSecondaryButton,
} from "../../lib/admin-styles";
import {
  fetchOpenHouseConfig,
  saveOpenHouseConfig,
  type OpenHouseConfig,
} from "../../lib/admin";
import {
  DEFAULT_OPEN_HOUSE_CONFIG,
  OPEN_HOUSE_DISPLAY_LIMIT,
  upcomingOpenHouses,
  validateOpenHouseConfig,
} from "../../../shared/open-house";
import { formatEventParts } from "../../../shared/format-date";
import {
  COMMON_TIME_ZONES,
  DEFAULT_TIME_ZONE,
  browserTimeZone,
  utcToZonedWallClock,
  zonedWallClockToUtc,
} from "../../lib/datetime";

export const Route = createFileRoute("/admin/open-houses")({
  component: OpenHousesAdmin,
});

// Same dropdown the announcement scheduler offers, plus the admin's own zone
// when it isn't already on the list.
const TIME_ZONE_OPTIONS = (() => {
  const tz = browserTimeZone();
  if (COMMON_TIME_ZONES.some((z) => z.value === tz)) return COMMON_TIME_ZONES;
  return [{ value: tz, label: `${tz} (your timezone)` }, ...COMMON_TIME_ZONES];
})();

// A row mid-edit. The instant is held as (zone, wall clock) rather than as the
// stored ISO string so "7:00 PM in London" stays 7:00 PM in London while the
// admin is still typing the rest of the row; it collapses to an instant on save.
// Duration is a string for the same reason the other admin forms do it — so the
// field can be cleared without the value snapping to 0.
type SessionRow = {
  id: string;
  timeZone: string;
  wallClock: string;
  durationMinutes: string;
  rsvpUrl: string;
  note: string;
};

const DEFAULT_DURATION_MINUTES = 45;

function rowsFrom(config: OpenHouseConfig): SessionRow[] {
  return config.sessions.map((s) => ({
    id: s.id,
    // The entry zone isn't persisted (only the instant is), so a saved row
    // reopens in the default zone — the same trade the announcement editor makes.
    timeZone: DEFAULT_TIME_ZONE,
    wallClock: utcToZonedWallClock(s.startsAt, DEFAULT_TIME_ZONE),
    durationMinutes: String(s.durationMinutes),
    rsvpUrl: s.rsvpUrl ?? "",
    note: s.note ?? "",
  }));
}

// Rows → the config shape the shared validator takes. A wall clock that doesn't
// parse yet (mid-edit, or cleared) becomes an empty instant, which the validator
// rejects with a row-numbered message rather than throwing here.
function configFrom(enabled: boolean, rows: SessionRow[]): unknown {
  return {
    enabled,
    sessions: rows.map((r) => {
      let startsAt = "";
      try {
        startsAt = zonedWallClockToUtc(r.wallClock, r.timeZone);
      } catch {
        /* left empty — the validator reports it against this row's number */
      }
      return {
        id: r.id,
        startsAt,
        durationMinutes: Number(r.durationMinutes),
        rsvpUrl: r.rsvpUrl,
        note: r.note,
      };
    }),
  };
}

/**
 * Next Wednesday at noon, as a wall clock in DEFAULT_TIME_ZONE — the cadence
 * the series runs on, so adding a session is one click plus a tweak.
 *
 * Built by calendar arithmetic on the *zone's* date rather than from the
 * admin's own `new Date()`: a new row's fields are read in the zone the row
 * selects (ET by default), so seeding them from the laptop's clock would put
 * "noon" several hours out for anyone editing from abroad. The UTC anchor below
 * is just a calendar to count days on — nothing is converted through it, so no
 * DST transition can shift the answer.
 */
function nextWednesdayNoon(): string {
  const today = utcToZonedWallClock(
    new Date().toISOString(),
    DEFAULT_TIME_ZONE,
  ).slice(0, 10);
  const [y, m, d] = today.split("-").map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  const daysAhead = (3 - anchor.getUTCDay() + 7) % 7 || 7; // 3 = Wednesday
  anchor.setUTCDate(anchor.getUTCDate() + daysAhead);
  return `${anchor.toISOString().slice(0, 10)}T12:00`;
}

function emptyRow(): SessionRow {
  return {
    id: crypto.randomUUID(),
    timeZone: DEFAULT_TIME_ZONE,
    wallClock: nextWednesdayNoon(),
    durationMinutes: String(DEFAULT_DURATION_MINUTES),
    rsvpUrl: "",
    note: "",
  };
}

function OpenHousesAdmin() {
  const [enabled, setEnabled] = useState(DEFAULT_OPEN_HOUSE_CONFIG.enabled);
  const [rows, setRows] = useState<SessionRow[]>(() =>
    rowsFrom(DEFAULT_OPEN_HOUSE_CONFIG),
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // Captured once, at mount: "upcoming" is relative to when the editor was
  // opened. Re-reading the clock during render is impure, and would let the
  // preview shift under the admin between two unrelated re-renders.
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    fetchOpenHouseConfig().then(
      (config) => {
        if (!live) return;
        setEnabled(config.enabled);
        setRows(rowsFrom(config));
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

  const patchRow = (id: string, patch: Partial<SessionRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  // The whole point of the form: see exactly which sessions /fold will list,
  // in the order visitors read them, before saving.
  const preview = validateOpenHouseConfig(configFrom(enabled, rows));
  const live = preview.ok ? upcomingOpenHouses(preview.value, nowMs) : [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const v = validateOpenHouseConfig(configFrom(enabled, rows));
    if (!v.ok) {
      setFormError(v.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const next = await saveOpenHouseConfig(v.value);
      setEnabled(next.enabled);
      setRows(rowsFrom(next));
      setSaved(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell active="open-houses" title="Open Houses">
      <div className="max-w-[760px]">
        <p className="text-body-sm text-fg-muted">
          The drop-in sessions advertised on the public Fold page. Visitors see
          the next {OPEN_HOUSE_DISPLAY_LIMIT}, soonest first; a session stays
          listed until it ends, then disappears on its own. Nothing scheduled
          means the section doesn't render at all — so an empty list is a safe
          state, not a broken one.
        </p>

        {loading ? (
          <p className="mt-8 text-body-sm text-fg-muted">Loading…</p>
        ) : loadError ? (
          <p className="mt-8 border border-rule bg-navy-900/60 p-4 text-body-sm text-red-300">
            {loadError}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-8 flex flex-col gap-8">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="mt-1 size-4 accent-cyan"
              />
              <span>
                <span className={adminFieldLabel}>Show Open Houses on /fold</span>
                <span className="mt-1 block text-body-sm text-fg-muted">
                  Off hides the whole section, whatever is scheduled below.
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-5">
              {rows.length === 0 ? (
                <p className="border border-rule bg-navy-900/60 p-4 text-body-sm text-fg-muted">
                  No sessions scheduled. Add one to bring the section back.
                </p>
              ) : null}

              {rows.map((row, i) => (
                <fieldset key={row.id} className="border border-rule p-4">
                  <legend className="px-2 label font-bold text-fg-strong">
                    Session {i + 1}
                  </legend>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={`tz-${row.id}`}
                        className={adminFieldLabel}
                      >
                        Time zone
                      </label>
                      <select
                        id={`tz-${row.id}`}
                        value={row.timeZone}
                        onChange={(e) =>
                          patchRow(row.id, { timeZone: e.target.value })
                        }
                        className={`${adminField} mt-2`}
                      >
                        {TIME_ZONE_OPTIONS.map((z) => (
                          <option key={z.value} value={z.value}>
                            {z.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor={`start-${row.id}`}
                        className={adminFieldLabel}
                      >
                        Starts
                      </label>
                      <input
                        id={`start-${row.id}`}
                        type="datetime-local"
                        value={row.wallClock}
                        onChange={(e) =>
                          patchRow(row.id, { wallClock: e.target.value })
                        }
                        className={`${adminField} mt-2`}
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`len-${row.id}`}
                        className={adminFieldLabel}
                      >
                        Length (minutes)
                      </label>
                      <input
                        id={`len-${row.id}`}
                        type="number"
                        min={5}
                        inputMode="numeric"
                        value={row.durationMinutes}
                        onChange={(e) =>
                          patchRow(row.id, { durationMinutes: e.target.value })
                        }
                        className={`${adminField} mt-2 max-w-[160px]`}
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={`rsvp-${row.id}`}
                        className={adminFieldLabel}
                      >
                        RSVP link (Zoom)
                      </label>
                      <input
                        id={`rsvp-${row.id}`}
                        type="url"
                        placeholder="https://zoom.us/meeting/register/…"
                        value={row.rsvpUrl}
                        onChange={(e) =>
                          patchRow(row.id, { rsvpUrl: e.target.value })
                        }
                        className={`${adminField} mt-2`}
                      />
                    </div>

                    <div className="sm:col-span-2">
                      <label
                        htmlFor={`note-${row.id}`}
                        className={adminFieldLabel}
                      >
                        Note (optional)
                      </label>
                      <input
                        id={`note-${row.id}`}
                        type="text"
                        maxLength={120}
                        placeholder="Evening session — friendlier for Europe and Israel"
                        value={row.note}
                        onChange={(e) =>
                          patchRow(row.id, { note: e.target.value })
                        }
                        className={`${adminField} mt-2`}
                      />
                    </div>
                  </div>

                  {!row.rsvpUrl.trim() ? (
                    <p className="mt-4 text-body-sm text-amber-300">
                      No RSVP link yet — the card will show the date and say the
                      link is coming, rather than offering a dead button.
                    </p>
                  ) : null}

                  <button
                    type="button"
                    onClick={() =>
                      setRows((rs) => rs.filter((r) => r.id !== row.id))
                    }
                    className="mt-4 button-text font-bold text-red-400 hover:text-red-300"
                  >
                    Remove session
                  </button>
                </fieldset>
              ))}

              <div>
                <button
                  type="button"
                  onClick={() => setRows((rs) => [...rs, emptyRow()])}
                  className={adminSecondaryButton}
                >
                  + Add session
                </button>
              </div>
            </div>

            <div className="border border-rule bg-navy-900/60 p-4">
              <p className={adminFieldLabel}>What /fold will show</p>
              {live.length === 0 ? (
                <p className="mt-2 text-body-sm text-fg-muted">
                  Nothing upcoming — the section will be hidden.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-1">
                  {live.map((s) => {
                    const when = formatEventParts(s.startsAt);
                    return (
                      <li key={s.id} className="text-body-sm text-fg-muted">
                        <span className="text-fg-strong">{when?.date}</span> ·{" "}
                        {when?.time}
                        {s.rsvpUrl ? "" : " — no RSVP link"}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-body-sm text-fg-muted">
                Times shown in your own timezone, the way a visitor sees theirs.
              </p>
            </div>

            {formError ? (
              <p className="border border-rule bg-navy-900/60 p-3 text-body-sm text-red-300">
                {formError}
              </p>
            ) : null}
            {saved ? (
              <p className="text-body-sm text-cyan">
                Saved. The Fold page picks this up within a minute.
              </p>
            ) : null}

            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex min-h-11 items-center bg-cyan px-6 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-fg-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                {saving ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </form>
        )}
      </div>
    </AdminShell>
  );
}
