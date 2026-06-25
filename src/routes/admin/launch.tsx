import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AdminShell } from "../../components/AdminShell";
import { getLaunchMode, saveLaunchMode } from "../../lib/admin";
import type { LaunchMode } from "../../lib/launchMode";

export const Route = createFileRoute("/admin/launch")({
  component: AdminLaunch,
});

const MODES: { id: LaunchMode; label: string; body: string }[] = [
  {
    id: "soft",
    label: "Soft launch",
    body: "Only the Inside Call Me Back page and the public site. The full Ark+ membership surfaces (pricing, gift, community, account upgrades) are hidden and their routes redirect to Inside Call Me Back.",
  },
  {
    id: "hard",
    label: "Hard launch",
    body: "The full Ark+ site: pricing, gift, community, the members newsletter, and all account/upgrade flows.",
  },
];

function AdminLaunch() {
  // `live` is the mode currently saved on the server; `selected` is the pending
  // choice in the form. Save is disabled until they differ.
  const [live, setLive] = useState<LaunchMode | null>(null);
  const [selected, setSelected] = useState<LaunchMode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getLaunchMode()
      .then((mode) => {
        if (cancelled) return;
        setLive(mode);
        setSelected(mode);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = selected !== null && selected !== live;

  async function save() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      const mode = await saveLaunchMode(selected);
      setLive(mode);
      setSelected(mode);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminShell active="launch" title="Launch mode">
      {loadError ? (
        <p className="text-body-sm text-red-400">{loadError}</p>
      ) : live === null ? (
        <p className="text-body-sm text-fg-faint">Loading…</p>
      ) : (
        <div className="max-w-[640px]">
          <p className="text-body-sm">
            Currently live:{" "}
            <strong className="text-fg-strong">
              {live === "soft" ? "Soft launch" : "Hard launch"}
            </strong>
            . Changes take effect site-wide within a minute, with no redeploy.
          </p>

          <div className="mt-6 flex flex-col gap-3">
            {MODES.map((m) => {
              const isSelected = selected === m.id;
              return (
                <label
                  key={m.id}
                  className={`flex cursor-pointer gap-3 border p-4 transition ${
                    isSelected
                      ? "border-cyan"
                      : "border-rule-strong hover:border-cyan"
                  }`}
                >
                  <input
                    type="radio"
                    name="launch-mode"
                    value={m.id}
                    checked={isSelected}
                    onChange={() => setSelected(m.id)}
                    className="mt-1 accent-cyan"
                  />
                  <span>
                    <span className="block button-text font-display font-bold text-fg-strong">
                      {m.label}
                      {m.id === live ? (
                        <span className="ml-2 text-cyan">· live</span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-body-sm">{m.body}</span>
                  </span>
                </label>
              );
            })}
          </div>

          {saveError ? (
            <p className="mt-4 text-body-sm text-red-400">{saveError}</p>
          ) : null}

          <div className="mt-6">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || saving}
              className="inline-flex min-h-11 items-center justify-center border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60"
            >
              {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
