import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LISTEN_PLATFORM_LABEL,
  getShow,
  showAtmosphere,
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
import {
  fetchPodcastDescription,
  listEpisodes,
  simplecastEpisodeSrc,
} from "../lib/simplecast";
import { subscribeEmail } from "../lib/beehiiv";
import { PageShell, PlaceholderSection } from "./PageShell";
import { Breadcrumbs } from "./Breadcrumbs";
import { HostArtwork } from "./HostArtwork";
import { ShowCover } from "./ShowCover";
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
              { label: "Podcasts", to: "/podcasts" },
              { label: "Not found" },
            ]}
          />
        }
        title="Show not found"
        lede="We couldn't find that show."
      >
        <PlaceholderSection
          title="Looking for a show?"
          body="Browse all of our podcasts from the hub."
        />
      </PageShell>
    );
  }

  return show.paid ? <PaidShowPage show={show} /> : <PublicShowPage show={show} />;
}

function PublicShowPage({ show }: { show: Show }) {
  const showHosts = hostsForShow(show.slug);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const description = useShowDescription(show);

  useEffect(() => {
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug]);

  // The featured episode is hoisted into the player at the top, so the grid and
  // the All-episodes list below both skip it — each episode renders exactly once.
  const featuredEpisode = episodes?.find((ep) => Boolean(ep.id)) ?? null;
  const remaining = (episodes ?? []).filter(
    (ep) => ep.slug !== featuredEpisode?.slug,
  );
  const latest = remaining.slice(0, 3);
  const archive = remaining.slice(3);

  return (
    <main className="relative">
      <ShowHero show={show} />

      <ShowAbout show={show} description={description} />

      {showHasPaidExtension(show.slug) ? <ShowUpsell show={show} /> : null}

      {featuredEpisode ? (
        <ShowPlayer show={show} episode={featuredEpisode} />
      ) : null}

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex items-end justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              {featuredEpisode ? "More episodes" : "Latest episodes"}
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
          ) : latest.length === 0 ? (
            <p className="mt-8 text-[14px] text-fg-muted">
              {featuredEpisode
                ? "That's the only episode so far — more coming soon."
                : "No episodes yet — check back soon."}
            </p>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {latest.map((ep) => (
                <EpisodeCard key={ep.slug} show={show} episode={ep} />
              ))}
            </div>
          )}

          <AllEpisodes show={show} episodes={archive} />
        </div>
      </section>

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
  const description = useShowDescription(show);

  // Drop episodes loaded in a prior member session once the viewer is no
  // longer a member, so a stale list can't flash if they sign back in.
  if (!isMember && episodes !== null) {
    setEpisodes(null);
  }

  useEffect(() => {
    if (!isMember) return;
    let live = true;
    void listEpisodes(show.slug).then((r) => live && setEpisodes(r));
    return () => {
      live = false;
    };
  }, [show.slug, isMember]);

  return (
    <main className="relative">
      <ShowHero show={show} />

      <ShowAbout show={show} description={description} />

      {isMember ? (
        <PaidShowMemberContent show={show} episodes={episodes} />
      ) : (
        <PaidShowJoinCta show={show} />
      )}

      {showHosts.length > 0 ? <HostsSection slugs={showHosts.map((h) => h.slug)} /> : null}

      <RelatedShows currentSlug={show.slug} relatedSlugs={show.related} />
    </main>
  );
}

function PaidShowMemberContent({
  show,
  episodes,
}: {
  show: Show;
  episodes: Episode[] | null;
}) {
  // The hero player and the episode cards used to both surface the latest
  // episode, which meant the same title rendered twice on the page. The
  // featured episode is now hoisted into the hero player at the top, and the
  // grid below skips it so each episode appears exactly once.
  const featuredEpisode = episodes?.find((ep) => Boolean(ep.id)) ?? null;
  const remaining = (episodes ?? []).filter(
    (ep) => ep.slug !== featuredEpisode?.slug,
  );
  const moreLatest = remaining.slice(0, 3);
  const archive = remaining.slice(3);

  return (
    <>
      {featuredEpisode ? (
        <ShowPlayer show={show} episode={featuredEpisode} />
      ) : null}

      <section className="border-t border-rule bg-navy-900">
        <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
          <div className="flex items-end justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              {featuredEpisode ? "More episodes" : "Latest episodes"}
            </div>
            <Link
              to="/account/podcast-feed"
              className="hidden text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted transition hover:text-cyan sm:inline"
            >
              Set up private feed →
            </Link>
          </div>

          {episodes === null ? (
            <p className="mt-8 text-[14px] text-fg-muted">Loading episodes…</p>
          ) : moreLatest.length === 0 ? (
            <p className="mt-8 text-[14px] text-fg-muted">
              {featuredEpisode
                ? "That's the only episode so far — more coming soon."
                : "No episodes yet — check back soon."}
            </p>
          ) : (
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {moreLatest.map((ep) => (
                <EpisodeCard key={ep.slug} show={show} episode={ep} />
              ))}
            </div>
          )}

          <AllEpisodes show={show} episodes={archive} />
        </div>
      </section>
    </>
  );
}

function PaidShowJoinCta({ show }: { show: Show }) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              Ark+ members only
            </div>
            <h2 className="mt-6 max-w-2xl font-display text-[clamp(1.5rem,3vw,2.4rem)] leading-[1.1] text-fg-strong">
              Join Ark+ to listen to {show.title}.
            </h2>
            <p className="mt-4 max-w-2xl text-[15px] leading-[1.7] text-fg">
              Members get extended interviews, ad-free episodes, members-only
              Q&amp;As, the Ark+ newsletter, and the community — one membership,
              one bill.
            </p>
          </div>
          <div className="lg:col-span-5">
            <div className="border border-rule bg-navy-800/40 p-8">
              <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
                Get Ark+
              </div>
              <p className="mt-4 text-[14px] leading-[1.6] text-fg">
                Full access to {show.title} plus everything else in Ark+.
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
  );
}

function ShowHero({ show }: { show: Show }) {
  return (
    <section className={`relative ${showAtmosphere(show.slug)}`}>
      <div className="mx-auto max-w-[1280px] px-6 pt-12 pb-12 sm:px-10 sm:pt-16">
        <Breadcrumbs
          className="rise rise-1 mb-6"
          items={[
            { label: "Home", to: "/" },
            { label: "Podcasts", to: "/podcasts" },
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

function ShowAbout({
  show,
  description,
}: {
  show: Show;
  description: string;
}) {
  return (
    <section className="border-t border-rule bg-navy-900">
      <div className="mx-auto max-w-[1280px] px-6 py-16 sm:px-10">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
              About
            </div>
            <p className="mt-6 max-w-2xl text-[15px] leading-[1.7] text-fg">
              {description}
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
  return (
    <ShowCover
      show={show}
      priority
      className="w-full max-w-md border border-rule shadow-cover"
    />
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
      to="/podcasts/$show/$episode"
      params={(prev) => ({
        ...prev,
        show: show.slug,
        episode: episode.slug,
      })}
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

// The archive list below the featured grid. Capped to roughly four rows
// (max-h-[14rem]) and scrolled internally so a long back catalog doesn't push
// the rest of the page down. Rows use line-clamp-1 so every row is the same
// height and the four-episode cap stays predictable.
function AllEpisodes({ show, episodes }: { show: Show; episodes: Episode[] }) {
  if (episodes.length === 0) return null;
  return (
    <div id="all-episodes" className="mt-16">
      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-fg-muted">
        All episodes
      </div>
      <ul className="mt-6 max-h-[14rem] divide-y divide-rule overflow-y-auto border-y border-rule">
        {episodes.map((ep) => (
          <li key={ep.slug}>
            <Link
              to="/podcasts/$show/$episode"
              params={(prev) => ({ ...prev, show: show.slug, episode: ep.slug })}
              className="group flex items-baseline justify-between gap-6 py-4 text-fg transition hover:text-cyan"
            >
              <span className="min-w-0 flex-1 text-[14px]">
                <span
                  className="line-clamp-1 font-display tracking-[-0.005em]"
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
                photo={h.headshot}
                name={h.name}
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
              className="group block overflow-hidden border border-rule bg-navy-800/40 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              <ShowCover show={s} className="border-b border-rule" />
              <div className="p-6">
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

// Returns the show description, preferring the live copy from Simplecast and
// falling back to the hardcoded one in `data/shows.ts`. The hook seeds with
// the local string so the page paints with real content immediately; the
// remote value is only adopted if it comes back non-empty and different,
// which avoids a one-frame text swap when the two strings already agree.
//
// State carries the slug it was hydrated for so navigating between shows
// resets the description during render (the React-recommended alternative to
// `setState` inside an effect).
function useShowDescription(show: Show): string {
  const [state, setState] = useState({
    slug: show.slug,
    value: show.description,
  });
  if (state.slug !== show.slug) {
    setState({ slug: show.slug, value: show.description });
  }
  useEffect(() => {
    let live = true;
    void fetchPodcastDescription(show.slug).then((d) => {
      if (!live || !d || d === show.description) return;
      setState((prev) =>
        prev.slug === show.slug ? { slug: show.slug, value: d } : prev,
      );
    });
    return () => {
      live = false;
    };
  }, [show.slug, show.description]);
  return state.value;
}
