import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { fetchMe } from "../../lib/auth";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";

type PrefKey = "free" | "ark-plus";

export const Route = createFileRoute("/account/newsletters")({
  beforeLoad: async () => {
    const me = await fetchMe();
    if (!me) throw redirect({ to: "/plus" });
    return { me };
  },
  component: NewsletterPrefs,
});

function NewsletterPrefs() {
  const { me } = Route.useRouteContext();
  const isMember = me.feeds.length > 0;
  const [prefs, setPrefs] = useState<Record<PrefKey, boolean>>({
    free: true,
    "ark-plus": isMember,
  });
  const [saved, setSaved] = useState(false);

  const toggle = (key: PrefKey) => {
    setPrefs((p) => ({ ...p, [key]: !p[key] }));
    setSaved(false);
  };

  /**
   * Mock save — real implementation would PATCH the user's beehiiv subscription
   * status across our free and paid publications and persist the choice in our DB.
   */
  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await new Promise((r) => setTimeout(r, 300));
    setSaved(true);
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
                description="Our free dispatch — the through-lines from this week's interviews and what they tell us about the week ahead."
                cadence="Weekly"
                on={prefs.free}
                onToggle={() => toggle("free")}
              />
              <PrefRow
                title="The Ark+ Members Letter"
                description="A members-only letter from the Ark Media editorial team — sharper analysis, source notes, and what we're reading."
                cadence="Weekly"
                badge="Ark+"
                on={prefs["ark-plus"]}
                onToggle={() => toggle("ark-plus")}
                locked={!isMember}
              />
            </ul>

            <button
              type="submit"
              className="mt-10 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan"
            >
              {saved ? "Saved" : "Save preferences"} →
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
      className={`relative inline-flex h-7 w-12 shrink-0 items-center border transition ${
        disabled
          ? "cursor-not-allowed border-rule bg-transparent opacity-40"
          : on
            ? "border-cyan bg-cyan/20"
            : "border-rule-strong bg-transparent hover:border-rule-strong"
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block size-5 transform bg-white transition ${
          on ? "translate-x-6 bg-cyan" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
