import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchNewsletterPrefs,
  saveNewsletterPrefs,
  type NewsletterPrefs as Prefs,
} from "../../lib/newsletterPrefs";
import {
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationPrefs,
} from "../../lib/notificationPrefs";
import { useSubscriberAuth } from "../../lib/subscriberAuth";
import { PageShell } from "../../components/PageShell";
import { ContentError } from "../../components/ContentError";
import { Breadcrumbs } from "../../components/Breadcrumbs";

export const Route = createFileRoute("/account/newsletters")({
  component: NewsletterPrefs,
});

function NewsletterPrefs() {
  const navigate = useNavigate();
  const { state, authError, refresh } = useSubscriberAuth();

  useEffect(() => {
    // Skip the redirect when "guest" is just an unreachable /api/me.
    if (!authError && state.kind === "guest") {
      void navigate({ to: "/plus" });
    }
  }, [state.kind, authError, navigate]);

  if (authError) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-navy-900 p-6">
        <div className="w-full max-w-md">
          <ContentError
            message="We couldn't load your newsletter settings. Refresh to try again."
            onRetry={refresh}
          />
        </div>
      </div>
    );
  }

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

function NewsletterPrefsForm({ me }: { me: { email: string; tier: "ark-plus-member" | "free" } }) {
  const isMember = me.tier === "ark-plus-member";
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
      title="Pick what lands in your inbox."
      lede={`Signed in as ${me.email}. Adjust at any time — toggling off won't delete past issues from your archive.`}
    >
      <section>
      <div className="page-gutter pt-10 pb-12">
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

          {isMember ? <NotificationsSection /> : null}
        </div>
      </div>
      </section>
    </PageShell>
  );
}

// Member-only "email me about new content" toggles. Loads from
// /api/me/notifications (our Neon-backed prefs) on mount; each toggle saves
// optimistically and rolls back on failure. Rendered only for Ark+ members,
// matching the server's 403-for-free-readers gate.
function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState<keyof NotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    setLoadError(null);
    return fetchNotificationPrefs().then((result) => {
      if (gen !== generation.current) return;
      if (result.ok) {
        setPrefs(result.prefs);
        return;
      }
      setPrefs(null);
      setLoadError(
        result.reason === "unauthenticated"
          ? "Session expired. Sign in again to manage notifications."
          : "Could not load notifications. Please refresh the page.",
      );
    });
  }, []);

  useEffect(() => {
    let live = true;
    // load() synchronously sets loading before fetching — a deliberate reset.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
      .catch(() => {
        if (!live) return;
        setPrefs(null);
        setLoadError("Could not load notifications. Please refresh the page.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [load]);

  const toggle = async (key: keyof NotificationPrefs) => {
    if (!prefs || saving || loading || loadError) return;
    const nextOn = !prefs[key];
    const previous = prefs;
    generation.current += 1;
    setPrefs((p) => (p ? { ...p, [key]: nextOn } : p));
    setSaving(key);
    setError(null);
    const result = await saveNotificationPrefs({ [key]: nextOn });
    setSaving(null);
    if (result.ok && result.prefs) {
      generation.current += 1;
      setPrefs(result.prefs);
      return;
    }
    setPrefs(previous);
    setError(result.error ?? "Could not update. Please try again.");
  };

  return (
    <div className="mt-8 border border-rule bg-navy-800/40 p-6 sm:p-8">
      <p className="label text-cyan">Notifications</p>
      <h2 className="mt-5 font-display text-[1.125rem] leading-snug text-fg-strong sm:text-[1.25rem]">
        New content alerts
      </h2>

      {loading ? (
        <div className="mt-6 animate-pulse space-y-6 motion-reduce:animate-none">
          <div className="h-6 w-full rounded-sm bg-rule-soft" />
          <div className="h-6 w-full rounded-sm bg-rule-soft" />
        </div>
      ) : loadError ? (
        <div className="mt-6">
          <p className="text-body-sm text-red-400" role="alert">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => void load().finally(() => setLoading(false))}
            className="mt-4 button-text font-display font-bold text-cyan underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Try again
          </button>
        </div>
      ) : prefs ? (
        <div className="mt-6 divide-y divide-rule">
          <NotifRow
            title="Episodes"
            description="Send me an email when a new episode is published."
            on={prefs.episodes}
            onToggle={() => void toggle("episodes")}
            busy={saving === "episodes"}
          />
          <NotifRow
            title="Posts"
            description="Send me an email when a new post is published."
            on={prefs.posts}
            onToggle={() => void toggle("posts")}
            busy={saving === "posts"}
          />
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 text-body-sm text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function NotifRow({
  title,
  description,
  on,
  onToggle,
  busy = false,
}: {
  title: string;
  description: string;
  on: boolean;
  onToggle: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <h3 className="font-display text-body text-fg-strong">{title}</h3>
        <p className="mt-1 text-body-sm">{description}</p>
      </div>
      <Toggle on={on} onClick={onToggle} busy={busy} />
    </div>
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
