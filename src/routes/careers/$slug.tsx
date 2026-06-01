import { createFileRoute, notFound } from "@tanstack/react-router";
import parse from "html-react-parser";
import { PageShell } from "../../components/PageShell";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { fetchCareer } from "../../lib/careers";
import { contactEmails } from "../../config/urls";

export const Route = createFileRoute("/careers/$slug")({
  loader: async ({ params }) => {
    const career = await fetchCareer(params.slug);
    if (!career) throw notFound();
    return { career };
  },
  component: CareerDetailPage,
});

function CareerDetailPage() {
  const { career } = Route.useLoaderData();
  const meta = [career.team, career.location, career.employmentType]
    .filter(Boolean)
    .join(" · ");

  // External application link (e.g. the role's TestGorilla assessment). Falls
  // back to the careers inbox when no apply URL is configured.
  const applyHref =
    career.applyUrl ??
    `mailto:${contactEmails.careers}?subject=${encodeURIComponent(
      `Application: ${career.title}`,
    )}`;
  const applyIsExternal = Boolean(career.applyUrl);

  return (
    <PageShell
      breadcrumbs={
        <Breadcrumbs
          items={[
            { label: "Home", to: "/" },
            { label: "Careers", to: "/careers" },
            { label: career.title },
          ]}
        />
      }
      eyebrow="Careers"
      title={career.title}
      lede={meta || undefined}
    >
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-12 px-6 py-16 sm:px-10 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="space-y-4 text-[15px] leading-[1.7] text-fg [&_a]:text-cyan [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-rule-strong [&_blockquote]:pl-4 [&_blockquote]:text-fg-muted [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-[22px] [&_h2]:leading-tight [&_h2]:text-fg-strong [&_h3]:mt-6 [&_h3]:font-display [&_h3]:text-[16px] [&_h3]:font-semibold [&_h3]:text-fg-strong [&_li]:ml-1 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_strong]:text-fg-strong [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5">
              {parse(career.description)}
            </div>
          </div>

          {/* Apply rail — sticky on desktop so the CTA stays in reach. */}
          <aside className="lg:col-span-4">
            <div className="border border-rule bg-navy-800/40 p-6 lg:sticky lg:top-24">
              <h2 className="font-display text-[18px] leading-tight text-fg-strong">
                Interested?
              </h2>
              {meta ? (
                <p className="mt-2 text-[13px] text-fg-muted">{meta}</p>
              ) : null}
              <a
                href={applyHref}
                {...(applyIsExternal
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="mt-5 inline-flex min-h-11 w-full items-center justify-center border border-cyan bg-cyan px-5 font-display text-[12px] font-bold uppercase tracking-button text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Apply to this job →
              </a>
              <p className="mt-3 text-[11px] leading-[1.5] text-fg-faint">
                {applyIsExternal
                  ? "Opens our application in a new tab."
                  : "Opens your email to send an application."}
              </p>
            </div>
          </aside>
        </div>
      </section>
    </PageShell>
  );
}
