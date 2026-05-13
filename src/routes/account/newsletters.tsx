import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { fetchMe } from "../../lib/auth";
import { newsletters } from "../../data/newsletters";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";

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
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(newsletters.map((n) => [n.slug, true])),
  );
  const [saved, setSaved] = useState(false);

  const toggle = (slug: string) => {
    setPrefs((p) => ({ ...p, [slug]: !p[slug] }));
    setSaved(false);
  };

  /**
   * Mock save — real implementation would PATCH the user's beehiiv subscription
   * status across publications and persist their selection in our DB.
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
              {newsletters.map((n) => (
                <li
                  key={n.slug}
                  className="flex items-start justify-between gap-6 py-5"
                >
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="font-display text-[18px] leading-tight text-fg-strong">
                        {n.title}
                      </span>
                      {n.tier === "ark-plus" ? (
                        <span className="border border-cyan/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan">
                          Ark+
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 max-w-md text-[13.5px] leading-[1.55] text-fg-muted">
                      {n.description}
                    </p>
                    <p className="mt-2 text-[12px] uppercase tracking-[0.18em] text-fg-muted">
                      {n.cadence}
                    </p>
                  </div>
                  <Toggle on={prefs[n.slug]} onClick={() => toggle(n.slug)} />
                </li>
              ))}
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

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center border transition ${
        on
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
