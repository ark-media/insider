import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { fetchMe } from "../../lib/auth";
import {
  fetchNewsletterPrefs,
  saveNewsletterPrefs,
  type NewsletterPrefs as Prefs,
} from "../../lib/newsletterPrefs";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";

export const Route = createFileRoute("/account/newsletters")({
  beforeLoad: async () => {
    const me = await fetchMe();
    if (!me) throw redirect({ to: "/plus" });
    return { me };
  },
  loader: async () => ({ prefs: await fetchNewsletterPrefs() }),
  component: NewsletterPrefs,
});

function NewsletterPrefs() {
  const { me } = Route.useRouteContext();
  const { prefs: initial } = Route.useLoaderData();
  const [prefs, setPrefs] = useState<Prefs>(
    initial ?? { free: false, premium: false, canPremium: me.tier === "subscriber" },
  );
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleFree = () => {
    setPrefs((p) => ({ ...p, free: !p.free }));
    setSaved(false);
    setError(null);
  };
  const togglePremium = () => {
    setPrefs((p) => ({ ...p, premium: !p.premium }));
    setSaved(false);
    setError(null);
  };

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const result = await saveNewsletterPrefs({
      free: prefs.free,
      premium: prefs.premium,
    });
    setSaving(false);
    if (result.ok && result.prefs) {
      setPrefs(result.prefs);
      setSaved(true);
    } else {
      setError(result.error ?? "Could not save. Please try again.");
    }
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
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <form onSubmit={onSave} className="max-w-3xl">
            <ul className="divide-y divide-rule border-y border-rule">
              <PrefRow
                title="The Ark Media Newsletter"
                description="Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead. Toggling off stops all Ark Media emails."
                cadence="Weekly"
                on={prefs.free}
                onToggle={toggleFree}
              />
              <PrefRow
                title="The Ark+ Members Letter"
                description="A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading."
                cadence="Weekly"
                badge="Ark+"
                on={prefs.premium}
                onToggle={togglePremium}
                locked={!prefs.canPremium}
              />
            </ul>

            {error ? (
              <p className="mt-6 text-[13px] text-red-400">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={saving}
              className="mt-10 inline-flex min-h-11 items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-50"
            >
              {saving ? "Saving" : saved ? "Saved" : "Save preferences"} →
            </button>
          </form>
        </div>
      </section>
    </PageShell>
  );
}

function PrefRow({
  title,
  description,
  cadence,
  badge,
  on,
  onToggle,
  locked = false,
}: {
  title: string;
  description: string;
  cadence: string;
  badge?: string;
  on: boolean;
  onToggle: () => void;
  locked?: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-6 py-5">
      <div>
        <div className="flex items-center gap-3">
          <span className="font-display text-[18px] leading-tight text-fg-strong">
            {title}
          </span>
          {badge ? (
            <span className="border border-cyan/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
              {badge}
            </span>
          ) : null}
        </div>
        <p className="mt-2 max-w-md text-[13.5px] leading-[1.55] text-fg-muted">
          {description}
        </p>
        <p className="mt-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
          {locked ? "Ark+ members only" : cadence}
        </p>
      </div>
      <Toggle on={on} onClick={onToggle} disabled={locked} />
    </li>
  );
}

function Toggle({
  on,
  onClick,
  disabled = false,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center border transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        disabled
          ? "cursor-not-allowed border-rule bg-transparent opacity-40"
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
