import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchNewsletterPrefs,
  saveNewsletterPrefs,
  type NewsletterPrefs,
} from "../../lib/newsletterPrefs";

// The Settings tab's email section: every list this address is on, in one
// place, each one switchable where switching means anything.
//
// This supersedes the standalone /account/newsletters page, which showed a
// member the members-letter toggle and a free reader the free-newsletter one —
// never both. An entitled member is on two lists and could only ever see one of
// them, so turning the daily off meant guessing where the switch lived. The
// prefs API has always carried `free` and `premium` independently; this just
// stops hiding one of them.

type Key = "premium" | "free";

const ROWS: Record<Key, { title: string; description: string }> = {
  premium: {
    title: "Members-only newsletter",
    description: "Weekly, from the hosts.",
  },
  free: {
    title: "Ark News Daily",
    description: "Every weekday morning.",
  },
};

export function EmailPreferences({ email }: { email: string }) {
  const [prefs, setPrefs] = useState<NewsletterPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Which row is mid-save, so only that switch goes busy rather than the list.
  const [saving, setSaving] = useState<Key | null>(null);
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

  const onToggle = async (key: Key) => {
    if (!prefs || saving || loading || loadError) return;
    const nextOn = !prefs[key];
    const previous = prefs;
    // Bump the generation so a load still in flight can't overwrite the
    // optimistic value with the pre-toggle one.
    loadGeneration.current += 1;
    setPrefs({ ...prefs, [key]: nextOn });
    setSaving(key);
    setError(null);
    const result = await saveNewsletterPrefs({ [key]: nextOn });
    setSaving(null);
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
        Sent to {email}. Change any of these at any time.
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
            {/* The members letter only exists for an entitled member. Showing
                it to a free reader would be a switch that can't be flipped. */}
            {prefs?.canPremium ? (
              <PrefRow
                title={ROWS.premium.title}
                description={ROWS.premium.description}
                on={prefs.premium}
                busy={saving === "premium"}
                onToggle={() => void onToggle("premium")}
              />
            ) : null}
            <PrefRow
              title={ROWS.free.title}
              description={ROWS.free.description}
              on={prefs?.free ?? false}
              busy={saving === "free"}
              onToggle={() => void onToggle("free")}
            />
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
      </div>
      {/* A labelled ON/OFF button rather than a sliding track: the state is the
          word, so it survives being read aloud, printed, or squinted at. */}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-busy={busy}
        aria-label={`${title} — ${on ? "subscribed" : "not subscribed"}`}
        onClick={onToggle}
        disabled={busy}
        className={`inline-flex min-h-8 shrink-0 items-center border px-3 text-[11px] font-semibold uppercase tracking-button transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
          busy
            ? "cursor-wait border-rule text-fg-muted opacity-60"
            : on
              ? "border-cyan bg-cyan/10 text-cyan hover:bg-cyan/20"
              : "border-rule-strong text-fg-muted hover:border-cyan hover:text-cyan"
        }`}
      >
        {busy ? "…" : on ? "On" : "Off"}
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
