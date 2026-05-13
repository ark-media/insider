import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LISTEN_PLATFORM_LABEL,
  getShow,
  type ListenLink,
  type Show,
  type ShowSlug,
} from "../data/shows";
import {
  formatDuration,
  formatEpisodeDate,
  type Episode,
} from "../data/episodes";
import { hostsForShow } from "../data/hosts";
import { listEpisodes, simplecastEpisodeSrc } from "../lib/simplecast";
import { subscribeEmail } from "../lib/beehiiv";
import { PageShell, PlaceholderSection } from "./PageShell";
import { Breadcrumbs } from "./Breadcrumbs";
import { HostArtwork } from "./HostArtwork";
import { ArkNewsDailyArtwork } from "./ArkNewsDailyArtwork";
import { useSubscriberAuth } from "../lib/subscriberAuth";

export function ShowPage({ slug }: { slug: ShowSlug }) {
  const show = getShow(slug);
  if (!show) {
    return (
      <PageShell
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Shows", to: "/shows" },
              { label: "Not found" },
            ]}
          />
        }
        title="Show not found"
        lede="We couldn't find that show."
      >
        <PlaceholderSection
          title="Looking for a show?"
          body="Browse all of our shows from the Shows hub."
        />
      </PageShell>
    );
  }

  return show.paid ? <PaidShowPage show={show} /> : <PublicShowPage show={show} />;
}

function PublicShowPage({ show }: { show: Show }) {
  const showHosts = hostsForShow(show.slug);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);

  useEffect(() => {
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug]);

  const latest = episodes?.slice(0, 3) ?? [];
  const featuredEpisode = episodes?.find((ep) => Boolean(ep.id)) ?? null;

  return (
    <main className="relative">
      <ShowHero show={show} />

      <ShowAbout show={show} />

      {showHasPaidExtension(show.slug) ? <ShowUpsell show={show} /> : null}

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex items-end justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Latest episodes
            </div>
            <a
              href="#all-episodes"
              className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted transition hover:text-cyan sm:inline"
            >
              View all episodes →
            </a>
          </div>

          {episodes === null ? (
            <p className="mt-8 text-[14px] text-fg-muted">Loading episodes…</p>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {latest.map((ep) => (
                <EpisodeCard key={ep.slug} show={show} episode={ep} />
              ))}
            </div>
          )}

          {episodes && episodes.length > 3 ? (
            <div id="all-episodes" className="mt-16">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
                All episodes
              </div>
              <ul className="mt-6 divide-y divide-rule border-y border-rule">
                {episodes.slice(3).map((ep) => (
                  <li key={ep.slug}>
                    <Link
                      to="/shows/$show/$episode"
                      params={{ show: show.slug, episode: ep.slug }}
                      className="group flex items-baseline justify-between gap-6 py-4 text-fg transition hover:text-cyan"
                    >
                      <span className="min-w-0 flex-1 text-[14px]">
                        <span
                          className="line-clamp-2 font-display tracking-[-0.005em]"
                          title={ep.title}
                        >
                          {ep.title}
                        </span>
                      </span>
                      <span className="hidden shrink-0 text-[11px] uppercase tracking-[0.18em] text-fg-muted group-hover:text-cyan sm:inline">
                        {formatEpisodeDate(ep.publishedAt)} · {formatDuration(ep.durationMinutes)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </section>

      {featuredEpisode ? (
        <ShowPlayer show={show} episode={featuredEpisode} />
      ) : null}

      {showHosts.length > 0 ? <HostsSection slugs={showHosts.map((h) => h.slug)} /> : null}

      <NewsletterCapture />

      <RelatedShows currentSlug={show.slug} relatedSlugs={show.related} />
    </main>
  );
}

function PaidShowPage({ show }: { show: Show }) {
  const { state } = useSubscriberAuth();
  const isMember = state.kind === "member";
  const showHosts = hostsForShow(show.slug);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);

  useEffect(() => {
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug]);

  return (
    <main className="relative">
      <ShowHero show={show} />

      {isMember ? (
        <section className="border-t border-rule bg-navy-900">
          <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              You're a member
            </div>
            <h2 className="mt-6 max-w-3xl font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
              Set up your private feed.
            </h2>
            <p className="mt-4 max-w-2xl text-[14px] leading-[1.7] text-fg">
              Inside Call Me Back is delivered as a private, ad-free feed in
              the podcast app you already use. Add it once and new episodes
              show up automatically.
            </p>
            <Link
              to="/account/podcast-feed"
              className="mt-8 inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Set up the feed →
            </Link>
          </div>
        </section>
      ) : (
        <PaidShowMarketing show={show} episodes={episodes} />
      )}

      {showHosts.length > 0 ? <HostsSection slugs={showHosts.map((h) => h.slug)} /> : null}

      <RelatedShows currentSlug={show.slug} relatedSlugs={show.related} />
    </main>
  );
}

function PaidShowMarketing({
  show,
  episodes,
}: {
  show: Show;
  episodes: Episode[] | null;
}) {
  const recent = episodes?.slice(0, 5) ?? [];

  return (
    <>
      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                What you get
              </div>
              <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
                {show.description}
              </p>
              <ul className="mt-8 space-y-3 text-[14px] text-fg">
                {[
                  "Extended, unedited interviews",
                  "Ad-free episodes",
                  "Members-only Q&As every other week",
                  "Full archive access",
                ].map((line) => (
                  <li key={line} className="flex items-start gap-3">
                    <span className="mt-[7px] h-px w-4 bg-cyan" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <div className="lg:col-span-5">
              <div className="border border-rule bg-navy-800/40 p-8">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                  Get Inside Call Me Back
                </div>
                <p className="mt-4 text-[14px] leading-[1.6] text-fg">
                  Included with Ark+. One membership, one bill — Inside CMB plus
                  members-only newsletters and the community.
                </p>
                <Link
                  to="/plus"
                  className="mt-8 inline-flex w-full items-center justify-between bg-cyan px-5 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900"
                >
                  See Ark+ membership
                  <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
            Recent episodes
          </div>
          <p className="mt-4 max-w-2xl text-[13px] text-fg-muted">
            Names only. Audio is reserved for Ark+ members.
          </p>
          {episodes === null ? (
            <p className="mt-8 text-[14px] text-fg-muted">Loading…</p>
          ) : (
            <ul className="mt-8 divide-y divide-rule border-y border-rule">
              {recent.map((ep) => (
                <li
                  key={ep.slug}
                  className="flex items-baseline justify-between gap-6 py-4"
                >
                  <span
                    className="line-clamp-2 min-w-0 flex-1 font-display text-[15px] tracking-[-0.005em] text-fg-strong"
                    title={ep.title}
                  >
                    {ep.title}
                  </span>
                  <span className="hidden shrink-0 text-[11px] uppercase tracking-[0.18em] text-fg-muted sm:inline">
                    {formatEpisodeDate(ep.publishedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

function ShowHero({ show }: { show: Show }) {
  const branded = show.slug === "ark-news-daily";
  return (
    <section className={`relative ${branded ? "and-bg" : ""}`}>
      <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
        <Breadcrumbs
          className="rise rise-1 mb-6"
          items={[
            { label: "Home", to: "/" },
            { label: "Shows", to: "/shows" },
            { label: show.shortTitle },
          ]}
        />
        <p className="inside-tab rise rise-1 text-[12px]">
          {show.shortTitle}
        </p>
        <div className="mt-10 grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h1 className="rise rise-2 max-w-3xl text-fg-strong">
              <span className="display-upright block text-[clamp(2.4rem,6vw,4.6rem)] leading-[1.02]">
                {show.title}
              </span>
            </h1>
            {show.hosts.length > 0 ? (
              <p className="rise rise-3 mt-6 text-[14px] uppercase tracking-[0.22em] text-fg-muted">
                with {show.hosts.join(" · ")}
              </p>
            ) : null}
            <p className="rise rise-4 mt-6 max-w-xl text-[15px] leading-[1.65] text-fg">
              {show.tagline}
            </p>
            {show.listen.length > 0 ? (
              <ListenRow listen={show.listen} className="mt-10" />
            ) : null}
          </div>
          <div className="lg:col-span-5">
            <ShowArtwork show={show} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowAbout({ show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              About
            </div>
            <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
              {show.description}
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
              Cadence
            </div>
            <p className="mt-3 text-[14px] text-fg">{show.cadence}</p>
            {show.listen.length > 0 ? (
              <>
                <div className="mt-8 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
                  Listen on
                </div>
                <ListenRow listen={show.listen} className="mt-3" />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowUpsell({ show: _show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-800/40">
      <div className="mx-auto max-w-[1280px] px-6 py-12 sm:px-10">
        <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Want more?
            </div>
            <p className="mt-3 max-w-2xl text-[15px] leading-[1.6] text-fg">
              <span className="font-display text-[18px]">Inside Call Me Back</span>{" "}
              delivers extended interviews, ad-free episodes, and
              members-only Q&amp;As — included with Ark+.
            </p>
          </div>
          <div className="lg:col-span-4 lg:text-right">
            <Link
              to="/plus"
              className="inline-flex items-center gap-2 border border-cyan bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Become an Ark+ member →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShowArtwork({ show }: { show: Show }) {
  if (show.slug === "ark-news-daily") {
    return <ArkNewsDailyArtwork title={show.title} />;
  }
  return (
    <div
      role="img"
      aria-label={`${show.title} — cover art`}
      className="relative aspect-square w-full max-w-md overflow-hidden border border-rule bg-gradient-to-br from-navy-800/80 via-navy-700/40 to-navy-900/80"
    >
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 60% 50% at 30% 30%, rgb(62 181 249 / 0.55) 0%, transparent 60%)",
        }}
      />
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          backgroundImage:
            "radial-gradient(ellipse 50% 40% at 75% 80%, rgb(62 181 249 / 0.28) 0%, transparent 65%)",
          animationDelay: "-4.5s",
          animationDuration: "11s",
        }}
      />
      <div className="absolute inset-0 flex flex-col justify-between p-8">
        <div className="eyebrow">{show.shortTitle}</div>
        <div className="display-upright text-[clamp(2rem,4vw,3rem)] leading-[0.9] text-fg-strong">
          {show.title}
        </div>
      </div>
    </div>
  );
}

function ListenRow({
  listen,
  className,
}: {
  listen: ListenLink[];
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-5 gap-y-3 text-[13px] text-fg-muted ${
        className ?? ""
      }`}
    >
      {listen.map((l) => (
        <a
          key={l.platform}
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          className="border border-rule-strong px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.18em] text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {LISTEN_PLATFORM_LABEL[l.platform]}
        </a>
      ))}
    </div>
  );
}

function EpisodeCard({ show, episode }: { show: Show; episode: Episode }) {
  return (
    <Link
      to="/shows/$show/$episode"
      params={{ show: show.slug, episode: episode.slug }}
      className="group block border border-rule bg-navy-800/40 p-6 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        {formatEpisodeDate(episode.publishedAt)} ·{" "}
        {formatDuration(episode.durationMinutes)}
      </div>
      <div
        className="mt-4 line-clamp-2 font-display text-[18px] leading-[1.2] text-fg-strong"
        title={episode.title}
      >
        {episode.title}
      </div>
      <p className="mt-3 line-clamp-3 text-[13px] leading-[1.6] text-fg-muted">
        {episode.description}
      </p>
      <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition group-hover:text-cyan">
        View episode →
      </div>
    </Link>
  );
}

function ShowPlayer({ show, episode }: { show: Show; episode: Episode }) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Listen here
        </div>
        <h2 className="mt-4 max-w-2xl font-display text-[clamp(1.4rem,2.6vw,2rem)] leading-[1.15] text-fg-strong">
          {show.cadence}.
        </h2>
        <div className="mt-8 border border-rule bg-navy-800/40">
          <iframe
            title={`${episode.title} — player`}
            src={simplecastEpisodeSrc(episode.id!)}
            height={200}
            width="100%"
            scrolling="no"
            allow="clipboard-write"
            loading="lazy"
            className="block w-full border-0"
          />
        </div>
      </div>
    </section>
  );
}

function HostsSection({ slugs }: { slugs: string[] }) {
  const hosts = slugs
    .map((s) => hostsForShow(s as ShowSlug))
    .flat()
    .filter((h, i, arr) => arr.findIndex((x) => x.slug === h.slug) === i);

  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Hosts
        </div>
        <div className="mt-10 grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {hosts.map((h, i) => (
            <Link
              key={h.slug}
              to="/hosts/$slug"
              params={{ slug: h.slug }}
              className="group block focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
            >
              <HostArtwork
                initials={h.initials}
                role={h.role}
                variant={i % 2 === 0 ? "primary" : "secondary"}
              />
              <h3 className="mt-5 font-display text-[20px] leading-tight text-fg-strong transition group-hover:text-cyan">
                {h.name}
              </h3>
              <p className="mt-2 max-w-sm text-[13px] leading-[1.55] text-fg-muted">
                {h.shortBio}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function NewsletterCapture() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "error">(
    "idle",
  );
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("submitting");
    const r = await subscribeEmail("the-call-me-back-newsletter", email.trim());
    if (r.ok) {
      setStatus("ok");
      setMessage("You're on the list.");
      setEmail("");
    } else {
      setStatus("error");
      setMessage(r.error ?? "Could not subscribe.");
    }
  };

  return (
    <section className="border-t border-rule bg-navy-800/40">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Newsletter
            </div>
            <h3 className="mt-6 max-w-md font-display text-[clamp(1.6rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
              Get the Call Me Back newsletter.
            </h3>
            <p className="mt-4 max-w-md text-[14px] leading-[1.6] text-fg">
              Dan's weekly dispatch — the through-lines from this week's
              interviews and what they tell us about the week ahead.
            </p>
          </div>
          <form onSubmit={onSubmit} className="lg:col-span-6">
            <label className="block">
              <span className="sr-only">Email</span>
              <div className="flex items-center border border-rule-strong bg-transparent transition focus-within:border-cyan">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-transparent px-4 py-3 text-[14px] text-fg-strong outline-none placeholder:text-fg-placeholder"
                />
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  aria-busy={status === "submitting"}
                  className="border-l border-rule-strong bg-cyan px-5 py-3 font-display text-[12px] font-bold uppercase tracking-[0.18em] text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:opacity-60"
                >
                  {status === "submitting" ? "Subscribing…" : "Subscribe"}
                </button>
              </div>
            </label>
            {message ? (
              <p
                className={`mt-3 text-[12px] ${
                  status === "error" ? "text-danger" : "text-cyan"
                }`}
                aria-live="polite"
              >
                {message}
              </p>
            ) : null}
          </form>
        </div>
      </div>
    </section>
  );
}

function RelatedShows({
  currentSlug,
  relatedSlugs,
}: {
  currentSlug: ShowSlug;
  relatedSlugs: ShowSlug[];
}) {
  const related = relatedSlugs
    .filter((s) => s !== currentSlug)
    .map((s) => getShow(s))
    .filter((s): s is Show => Boolean(s));

  if (related.length === 0) return null;

  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          Related shows
        </div>
        <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {related.map((s) => (
            <Link
              key={s.slug}
              to={s.route}
              className="group block border border-rule bg-navy-800/40 p-6 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                {s.shortTitle}
              </div>
              <div className="mt-4 font-display text-[20px] leading-[1.15] text-fg-strong">
                {s.title}
              </div>
              <p className="mt-3 text-[13px] leading-[1.6] text-fg-muted">
                {s.tagline}
              </p>
              <div className="mt-6 text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted transition group-hover:text-cyan">
                Visit show →
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function showHasPaidExtension(slug: ShowSlug): boolean {
  return slug === "call-me-back";
}
