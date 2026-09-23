import { useCallback, useEffect, useRef, useState } from "react";
import { newsletter } from "../../data/newsletters";
import {
  fetchNewsletterPrefs,
  saveNewsletterPrefs,
  type NewsletterPrefs,
} from "../../lib/newsletterPrefs";

// The Settings tab's email section.
//
// There is one newsletter. Free and Ark+ readers get different editions of it
// — the edition is the premium tier on the reader's Beehiiv record, which the
// membership sets and removes (server/lib/beehiiv-sync.ts), not something the
// reader picks. So the only switch here is whether the newsletter arrives at
// all: `free` in /api/me/newsletters, i.e. subscribed to the publication.
// Turning it back on for an Ark+ member re-applies their edition server-side
// (server/routes/me.ts).

export function EmailPreferences({ email }: { email: string }) {
  const [prefs, setPrefs] = useState<NewsletterPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const loadPrefs = useCallback(() => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    return fetchNewsletterPrefs().then((result) => {
      if (generation !== loadGeneration.current) return;
      if (result.ok) {
        setPrefs(result.prefs);
        return;
      }
      setPrefs(null);
      setLoadError(
        result.reason === "unauthenticated"
          ? "Session expired. Sign in again to manage preferences."
          : "Could not load preferences. Please refresh the page.",
      );
    });
  }, []);

  useEffect(() => {
    let live = true;
    // loadPrefs synchronously sets the loading state before fetching; this is a
    // deliberate reset on account/email change, not a cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPrefs()
      .catch(() => {
        if (!live) return;
        setPrefs(null);
        setLoadError("Could not load preferences. Please refresh the page.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [email, loadPrefs]);

  const onToggle = async () => {
    if (!prefs || saving || loading || loadError) return;
    const patch = { free: !prefs.free };
    const previous = prefs;
    // Bump the generation so a load still in flight can't overwrite the
    // optimistic value with the pre-toggle one.
    loadGeneration.current += 1;
    setPrefs({ ...prefs, ...patch });
    setSaving(true);
    setError(null);
    const result = await saveNewsletterPrefs(patch);
    setSaving(false);
    if (result.ok && result.prefs) {
      loadGeneration.current += 1;
      setPrefs(result.prefs);
      return;
    }
    setPrefs(previous);
    setError(result.error ?? "Could not update. Please try again.");
  };

  return (
    <div>
      <h3 className="label text-cyan">Email preferences</h3>
      <p className="mt-2 text-body-sm text-fg-muted">
        Sent to {email}. Change this at any time.
      </p>

      <div className="mt-4 divide-y divide-rule border border-rule bg-navy-800/40">
        {loading ? (
          <PrefSkeleton />
        ) : loadError ? (
          <div className="p-6">
            <p className="text-body-sm text-danger" role="alert">
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => {
                void loadPrefs().finally(() => setLoading(false));
              }}
              className="mt-4 button-text font-display font-bold text-cyan underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            {prefs ? (
              <PrefRow
                title={newsletter.title}
                description={
                  prefs.canPremium
                    ? "Weekly. You get the members' edition, with the members-only sections."
                    : "Weekly. The free edition — Ark+ members get the members' edition."
                }
                on={prefs.free}
                busy={saving}
                onToggle={() => void onToggle()}
              />
            ) : null}
            {/* Not a switch. Receipts, renewal notices and cancellation
                confirmations are how a member finds out what they were charged,
                so there is nothing here to opt out of — and a disabled toggle
                would suggest otherwise. */}
            <div className="flex items-center justify-between gap-4 p-6">
              <div className="min-w-0">
                <h4 className="text-h5">Account &amp; billing notices</h4>
                <p className="mt-1 text-body-sm text-fg-muted">
                  Receipts and renewal reminders. Always on.
                </p>
              </div>
              <span className="shrink-0 border border-rule px-2 py-1 text-[11px] font-semibold uppercase tracking-button text-fg-muted">
                Required
              </span>
            </div>
          </>
        )}
      </div>

      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PrefRow({
  title,
  description,
  on,
  busy,
  onToggle,
}: {
  title: string;
  description: string;
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-6">
      <div className="min-w-0">
        <h4 className="text-h5">{title}</h4>
        <p className="mt-1 text-body-sm text-fg-muted">{description}</p>
        {/* The button names the action, so the current state is spelled out
            here rather than left for the reader to infer from it. */}
        <p
          className={`mt-2 text-[11px] font-semibold uppercase tracking-button ${
            on ? "text-cyan" : "text-fg-muted"
          }`}
        >
          {on ? "Subscribed" : "Not subscribed"}
        </p>
      </div>
      <button
        type="button"
        aria-busy={busy}
        aria-label={`${on ? "Unsubscribe from" : "Subscribe to"} ${title}`}
        onClick={onToggle}
        disabled={busy}
        className={`inline-flex min-h-11 shrink-0 items-center border px-4 button-text font-display font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
          busy
            ? "cursor-wait border-rule text-fg-muted opacity-60"
            : on
              ? "border-rule-strong text-fg-muted hover:border-cyan hover:text-cyan"
              : "border-cyan bg-cyan text-navy hover:bg-transparent hover:text-cyan"
        }`}
      >
        {busy
          ? on
            ? "Subscribing…"
            : "Unsubscribing…"
          : on
            ? "Unsubscribe"
            : "Subscribe"}
      </button>
    </div>
  );
}

function PrefSkeleton() {
  return (
    <div className="animate-pulse p-6 motion-reduce:animate-none">
      <div className="flex items-start justify-between gap-4">
        <div className="w-full">
          <div className="h-4 w-48 rounded-sm bg-rule-soft" />
          <div className="mt-3 h-3 w-32 rounded-sm bg-rule-soft" />
        </div>
        <div className="h-8 w-14 shrink-0 bg-rule-soft" />
      </div>
    </div>
  );
}
