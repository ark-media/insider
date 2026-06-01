import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchNewsletterPrefs,
  saveNewsletterPrefs,
  type NewsletterPrefs as Prefs,
} from "../../lib/newsletterPrefs";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";

export const Route = createFileRoute("/account/newsletters")({
  component: NewsletterPrefs,
});

function NewsletterPrefs() {
  const navigate = useNavigate();
  const { state } = useSubscriberAuth();

  useEffect(() => {
    if (state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, navigate]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900">
        <p className="text-fg-muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "guest") return null;

  return <NewsletterPrefsForm me={state.me} />;
}

function NewsletterPrefsForm({ me }: { me: { email: string; tier: "subscriber" | "free" } }) {
  const isMember = me.tier === "subscriber";
  const [prefs, setPrefs] = useState<Prefs | null>(null);
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
  }, [isMember, me.email, loadPrefs]);

  const on = isMember ? (prefs?.premium ?? false) : (prefs?.free ?? false);

  const onToggle = async () => {
    if (!prefs || saving || loading || loadError) return;
    const nextOn = !on;
    const previous = prefs;
    loadGeneration.current += 1;
    setPrefs((p) =>
      p
        ? isMember
          ? { ...p, premium: nextOn }
          : { ...p, free: nextOn }
        : p,
    );
    setSaving(true);
    setError(null);
    const result = await saveNewsletterPrefs(
      isMember ? { premium: nextOn } : { free: nextOn },
    );
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
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Account", to: "/account" },
            { label: "Newsletter preferences" },
          ]}
        />
      }
      eyebrow="Newsletter preferences"
      title="Pick what lands in your inbox."
      lede={`Signed in as ${me.email}. Adjust at any time — toggling off won't delete past issues from your archive.`}
    >
      <section>
      <div className="mx-auto max-w-[1280px] -mt-4 px-6 pb-20 sm:px-10">
        <div className="max-w-xl">
          <div className="border border-rule bg-navy-800/40 p-6 sm:p-8">
            {loading ? (
              <PrefSkeleton />
            ) : loadError ? (
              <PrefError
                message={loadError}
                onRetry={() => {
                  void loadPrefs().finally(() => setLoading(false));
                }}
              />
            ) : isMember ? (
              <PrefRow
                label="Members letter"
                title="The Ark+ Members Letter"
                description="A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading. Turning off keeps you on the free newsletter."
                cadence="Weekly"
                badge="Ark+"
                on={on}
                onToggle={() => void onToggle()}
                busy={saving}
              />
            ) : (
              <PrefRow
                label="Free newsletter"
                title="The Ark Media Newsletter"
                description="Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead. Toggling off stops all Ark Media emails."
                cadence="Weekly"
                on={on}
                onToggle={() => void onToggle()}
                busy={saving}
              />
            )}
          </div>

          {error ? (
            <p className="mt-4 text-body-sm text-red-400" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      </section>
    </PageShell>
  );
}

function PrefSkeleton() {
  return (
    <div className="animate-pulse motion-reduce:animate-none">
      <div className="h-3 w-28 rounded-sm bg-rule-soft" />
      <div className="mt-6 flex items-start justify-between gap-4">
        <div className="h-6 w-48 rounded-sm bg-rule-soft" />
        <div className="h-7 w-12 shrink-0 bg-rule-soft" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-3 w-full rounded-sm bg-rule-soft" />
        <div className="h-3 w-4/5 rounded-sm bg-rule-soft" />
      </div>
      <div className="mt-4 h-3 w-16 rounded-sm bg-rule-soft" />
    </div>
  );
}

function PrefError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div>
      <p className="text-body-sm text-red-400" role="alert">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 button-text font-display font-bold text-cyan underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Try again
      </button>
    </div>
  );
}

function PrefRow({
  label,
  title,
  description,
  cadence,
  badge,
  on,
  onToggle,
  busy = false,
}: {
  label: string;
  title: string;
  description: string;
  cadence: string;
  badge?: string;
  on: boolean;
  onToggle: () => void;
  busy?: boolean;
}) {
  return (
    <div>
      <p className="label text-cyan">
        {label}
      </p>

      <div className="mt-5 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="font-display text-[1.125rem] leading-snug text-fg-strong sm:text-[1.25rem]">
              {title}
            </h2>
            {badge ? (
              <span className="border border-cyan/60 px-2 py-0.5 label text-cyan">
                {badge}
              </span>
            ) : null}
          </div>
        </div>
        <Toggle on={on} onClick={onToggle} busy={busy} />
      </div>

      <p className="mt-3 text-body-sm">
        {description}
      </p>
      <p className="mt-3 label text-fg-faint">
        {cadence}
      </p>
    </div>
  );
}

function Toggle({
  on,
  onClick,
  busy = false,
}: {
  on: boolean;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-busy={busy}
      aria-label={on ? "Subscribed" : "Not subscribed"}
      onClick={onClick}
      disabled={busy}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        busy
          ? "cursor-wait border-rule bg-transparent opacity-40"
          : on
            ? "border-cyan bg-cyan/20"
            : "border-rule-strong bg-transparent hover:border-cyan"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-5 transform transition ${
          on ? "translate-x-6 bg-cyan" : "translate-x-0.5 bg-fg-strong"
        }`}
      />
    </button>
  );
}
