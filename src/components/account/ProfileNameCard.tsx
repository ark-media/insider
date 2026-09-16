// "What should we call you?" — the account surface that captures a member's
// name and lets them edit it later.
//
// One component with two presentations rather than a separate prompt and
// settings field, so the two can never disagree about what we hold:
//
//   needs a name, not dismissed → a loud card asking for it
//   needs a name, dismissed     → a quiet "Not set · Add" row
//   has a name                  → a quiet "Hannah Waxman · Edit" row
//
// Dismissal only demotes the card to the quiet row; it never removes the
// editable field, so someone who said "not now" can still add or fix a name.
//
// `promptOnly` drops the quiet row, leaving just the ask. /welcome renders it
// that way: it's a setup checklist, not a settings page, so a member whose name
// we already hold should see nothing there at all. Dismissal is one shared flag
// on purpose — "not now" said on /welcome is still "not now" on /account, where
// they'll meet the quiet row instead.
//
// "Needs a name" is the server's judgement, never `!givenName` — most migrated
// members have a name we manufactured from their email address, and treating
// that as real is what ships "Hi hannah.waxman8," to the whole list.

import { useEffect, useState } from "react";
import { fetchProfile, saveProfile, type Profile } from "../../lib/profile";

const DISMISS_KEY = "ark_name_prompt_dismissed";

const inputClass =
  "w-full border border-rule-strong bg-transparent px-3 py-2.5 text-fg-strong placeholder:text-fg-placeholder outline-none transition focus:border-cyan disabled:opacity-50";

const ctaClass =
  "inline-flex min-h-11 items-center gap-2 border border-cyan bg-cyan px-5 py-3 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50";

const linkClass =
  "text-body-sm text-cyan underline underline-offset-4 transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // Private mode / blocked storage — show the prompt rather than crash.
    return false;
  }
}

export function ProfileNameCard({
  onSaved,
  promptOnly = false,
  rowClassName = "mb-10 border-b border-rule pb-6",
}: {
  onSaved?: () => void;
  /** Render only the ask — no quiet "Your name · Edit" row. See the note above. */
  promptOnly?: boolean;
  /**
   * Wrapper classes for the quiet row, so it can sit as one row inside the
   * Settings tab's bordered "Profile & sign-in" list instead of carrying its
   * own trailing rule. Only the frame changes; the row itself is identical.
   */
  rowClassName?: string;
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [editing, setEditing] = useState(false);
  // True only because they saved during *this* visit. In promptOnly mode there
  // is no quiet row to fall back to, and a card that evaporates on submit reads
  // as a bug rather than a success.
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchProfile().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setProfile(res.profile);
      } else {
        setFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A Management API blip must not break the account page — say nothing.
  if (failed) return null;
  // No skeleton in promptOnly: the space is only ever claimed by members who
  // need the ask, so a placeholder that resolves to nothing would be a worse
  // flash than the card arriving a beat late.
  if (!profile) return promptOnly ? null : <NameSkeleton className={rowClassName} />;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage failures; the dismissal just won't persist.
    }
    setDismissed(true);
  };

  const onSave = (next: Profile) => {
    setProfile(next);
    setEditing(false);
    setJustSaved(true);
    onSaved?.();
  };

  const full = [profile.givenName, profile.familyName].filter(Boolean).join(" ");

  if (promptOnly) {
    // Confirm the save in place, then say where to change it — the ask is gone
    // for good otherwise, and they have no reason to believe it landed.
    if (justSaved) {
      return (
        <div className="border border-rule bg-navy-800/40 p-8">
          <div className="eyebrow text-fg-muted">Your name</div>
          <p className="mt-3 text-body text-fg-strong">{full}</p>
          <p className="mt-2 text-body-sm text-fg-muted">
            Thanks — we'll use this from now on. You can change it any time in
            your account.
          </p>
        </div>
      );
    }
    // Nothing to ask, or they've waved it off: this surface is the ask only.
    if (!profile.needsName || dismissed) return null;
  }

  // The loud ask: only while we have no real name and they haven't waved it off.
  if (profile.needsName && !dismissed && !editing) {
    return (
      <div
        className={`border border-cyan/40 bg-navy-800/40 p-8 ${promptOnly ? "" : "mb-10"}`}
      >
        <div className="eyebrow">Personalize</div>
        <h2 className="mt-4 font-display text-[clamp(1.4rem,2.4vw,1.9rem)] leading-[1.15] text-fg-strong">
          What should we call you?
        </h2>
        <p className="mt-3 max-w-prose text-body-sm text-fg-muted">
          We never collected your name, so our emails currently open with a
          rather impersonal "Hi there." Add it and we'll use it instead.
        </p>
        <NameForm
          profile={profile}
          onSave={onSave}
          secondary={
            <button type="button" onClick={dismiss} className={linkClass}>
              Not now
            </button>
          }
        />
      </div>
    );
  }

  // The quiet row: the permanent, always-available editable field.
  return (
    <div className={rowClassName}>
      {editing ? (
        <>
          <div className="eyebrow text-fg-muted">Your name</div>
          <NameForm
            profile={profile}
            onSave={onSave}
            secondary={
              <button
                type="button"
                onClick={() => setEditing(false)}
                className={linkClass}
              >
                Cancel
              </button>
            }
          />
        </>
      ) : (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <div className="eyebrow text-fg-muted">Your name</div>
            <p className="mt-2 text-body text-fg-strong">
              {profile.needsName ? (
                <span className="text-fg-muted">Not set</span>
              ) : (
                full
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={linkClass}
          >
            {profile.needsName ? "Add your name" : "Edit"}
          </button>
        </div>
      )}
    </div>
  );
}

function NameForm({
  profile,
  onSave,
  secondary,
}: {
  profile: Profile;
  onSave: (next: Profile) => void;
  secondary: React.ReactNode;
}) {
  // Seeded blank when the stored name is one we manufactured — prefilling
  // "hannah.waxman8" invites them to just accept it.
  const [first, setFirst] = useState(profile.needsName ? "" : (profile.givenName ?? ""));
  const [last, setLast] = useState(profile.needsName ? "" : (profile.familyName ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await saveProfile({
      givenName: first.trim(),
      familyName: last.trim(),
    });
    setBusy(false);
    if (res.ok && res.profile) {
      onSave(res.profile);
      return;
    }
    setError(res.error ?? "Could not save. Please try again.");
  };

  return (
    <form onSubmit={submit} className="mt-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-lg">
        <label className="block">
          <span className="eyebrow text-fg-muted">First name</span>
          <input
            type="text"
            value={first}
            onChange={(e) => setFirst(e.target.value)}
            autoComplete="given-name"
            maxLength={40}
            required
            disabled={busy}
            className={`mt-2 ${inputClass}`}
          />
        </label>
        <label className="block">
          <span className="eyebrow text-fg-muted">Last name (optional)</span>
          <input
            type="text"
            value={last}
            onChange={(e) => setLast(e.target.value)}
            autoComplete="family-name"
            maxLength={40}
            disabled={busy}
            className={`mt-2 ${inputClass}`}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-5">
        <button
          type="submit"
          disabled={busy || !first.trim()}
          aria-busy={busy}
          className={ctaClass}
        >
          {busy ? "Saving…" : "Save"} →
        </button>
        {secondary}
      </div>
    </form>
  );
}

function NameSkeleton({ className }: { className: string }) {
  return (
    <div className={`animate-pulse motion-reduce:animate-none ${className}`}>
      <div className="h-3 w-24 rounded-sm bg-rule-soft" />
      <div className="mt-4 h-6 w-44 rounded-sm bg-rule-soft" />
    </div>
  );
}
