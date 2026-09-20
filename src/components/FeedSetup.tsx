import { useEffect, useId, useState, useSyncExternalStore } from "react";
import QRCode from "qrcode";
import {
  ApplePodcastsIcon,
  OvercastIcon,
  PocketCastsIcon,
  SpotifyIcon,
} from "./PlatformIcons";
import { OutboundLink } from "./OutboundLink";
import { spotifyLibraryUrl } from "../config/urls";
import { feedIsSetUp, sendFeedEmail, type UserFeed } from "../lib/auth";
import { trackEvent } from "../lib/analytics";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { useSubscriberAuth } from "../lib/subscriberAuth";

// Server route that mints Beehiiv's auto-login and 302s the member into
// Beehiiv's Spotify consent flow. Open Access verifies the click originated on
// Beehiiv, so there is no direct Spotify URL we can link. The round trip ends
// on /account/podcast-feed with `?spotify=linked` — see buildSpotifyHandoff.
const SPOTIFY_HANDOFF_PATH = "/api/me/feeds/spotify";

// The apps we can hand off to with one tap, in the order they're listed.
// `protocolKey` is the key in Beehiiv's `protocol_links`; an app whose key
// Beehiiv didn't return for a feed is dropped, because our only fallback would
// be the raw RSS URL, which none of these apps can open. Everything else is
// served by the "copy the feed URL" row at the bottom.
//
// `desktopBox` names the "add by URL" box that app's DESKTOP client opens, and
// null means don't offer one at all. Overcast and Castro are iOS-only, and
// Pocket Casts' Mac app is rare enough that a row promising to open it is more
// likely to do nothing than to help — on a computer those three are the QR code
// and nothing else.
const APPS = [
  {
    key: "apple",
    name: "Apple Podcasts",
    protocolKey: "apple",
    Icon: ApplePodcastsIcon,
    // Verified 2026-09-11 on macOS 15: the Mac app registers `podcast:` (and
    // `pcast:`) but throws the feed URL away — it opens this box EMPTY however
    // the link is formed. Nothing we can send fixes it, so the desktop row
    // copies the feed URL on the way out and says where to paste it.
    desktopBox: "Follow a Show by URL",
  },
  { key: "overcast", name: "Overcast", protocolKey: "overcast", Icon: OvercastIcon, desktopBox: null },
  {
    key: "pocketcasts",
    name: "Pocket Casts",
    protocolKey: "pocket_casts",
    Icon: PocketCastsIcon,
    desktopBox: null,
  },
  { key: "castro", name: "Castro", protocolKey: "castro", Icon: null, desktopBox: null },
] as const;

type App = (typeof APPS)[number];

// Is this the device the podcast app lives on? A protocol link only finishes
// the job there — on a computer it either opens nothing (Overcast, Castro) or
// opens the app with the feed URL dropped on the floor (Apple), which is what
// makes the QR code the real desktop path rather than a convenience.
//
// `pointer: coarse` reports the PRIMARY input, so a touchscreen laptop with a
// trackpad still counts as desktop. Width would be the wrong question: a
// half-width browser window on a Mac is still a Mac.
function useHandheld(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia?.("(pointer: coarse)");
      mql?.addEventListener("change", onChange);
      return () => mql?.removeEventListener("change", onChange);
    },
    () => window.matchMedia?.("(pointer: coarse)").matches ?? false,
    () => false,
  );
}

/**
 * Private-feed setup: a flat list of deep links, one tap each.
 *
 * The shape of this page follows the shape of the job. On a phone the member
 * is already holding the device the podcast app lives on, so every row is just
 * a link they tap and the app opens with the feed in it.
 *
 * On a computer that tap goes nowhere useful — Overcast and Castro don't exist
 * there at all, Pocket Casts' Mac app is rarely installed, and Apple's Mac app
 * opens its "Follow a Show by URL" box EMPTY however the protocol link is
 * formed (verified 2026-09-11). So on a computer every row is the QR code,
 * which moves the member to the device that can finish the job, and Apple —
 * the one desktop app people do listen in — keeps an "open here" that copies
 * the feed URL first so the empty box is one paste from done.
 *
 * Spotify stays first and set apart: it links the account rather than a device,
 * so it covers every show at once on whatever the member is holding. The
 * hand-off leaves this tab for Beehiiv and Spotify, then Beehiiv sends them
 * back with `?spotify=linked` — that's when the "now follow the show" half
 * appears, keyed off the real return rather than the click.
 */
export function FeedSetup({
  feeds,
  spotifyLinked = false,
  provisioning = false,
}: {
  feeds: UserFeed[];
  /**
   * The member is entitled to feeds but holds none yet, and the page is still
   * polling for them (Beehiiv mints them seconds after the membership lands —
   * see FEED_POLL_WINDOW_MS in the route). Only changes what the empty state
   * says: that they're on their way, rather than that there are none.
   */
  provisioning?: boolean;
  /**
   * The member came back from Beehiiv's Spotify consent flow carrying
   * `?spotify=linked`. That's the only signal that Open Access actually
   * finished — the click itself is not a confirmation.
   */
  spotifyLinked?: boolean;
}) {
  const { markFeedsSetUp } = useSubscriberAuth();

  // Which show is expanded. One at a time, opening on the first one that still
  // needs doing — the page is a checklist, and the useful default is "the next
  // thing", not "everything at once" or "nothing".
  //
  // Computed once. Recomputing it from `feeds` on every render would yank the
  // panel out from under a member the moment a feed flipped to set up, which is
  // exactly when they may still be reading it.
  const [openId, setOpenId] = useState<string | null>(
    () => feeds.find((f) => !feedIsSetUp(f))?.id ?? null,
  );

  // Move to the next show still to do once one is finished, so a member with
  // four of them is never left staring at a panel whose job is done. Wraps, so
  // finishing the last one lands on any earlier straggler rather than nothing.
  const advancePast = (feedId: string) => {
    const from = feeds.findIndex((f) => f.id === feedId);
    const next =
      feeds.slice(from + 1).find((f) => !feedIsSetUp(f)) ??
      feeds.find((f) => f.id !== feedId && !feedIsSetUp(f));
    setOpenId(next?.id ?? null);
  };

  return (
    <section>
      <div className="page-section">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
          <div className="min-w-0">
            <h2 className="text-h2">Set up your private feed</h2>
            <p className="mt-4 max-w-2xl text-body">
              Pick where you listen. These links carry your membership, so keep
              them to yourself.
            </p>
          </div>
          {feeds.length > 0 ? <SetupProgress feeds={feeds} /> : null}
        </div>

        {feeds.length === 0 ? (
          <div className="mt-10 border border-rule bg-navy-900/60 p-6 text-body-sm text-fg">
            {provisioning
              ? "Setting up your private feeds. This takes up to a minute — they'll appear here on their own, so you don't need to reload."
              : // Two minutes of polling found nothing, so "give it a minute"
                // would be the wrong advice. Points at the Help button, which
                // is on this page, rather than at a link that leaves it.
                "No private feeds on your membership yet. Your membership is active — reload the page, and if they still don't appear, hit Help and we'll sort it out."}
          </div>
        ) : (
          <>
            <SpotifyRow
              linked={spotifyLinked}
              onLink={() => {
                trackEvent("feed_spotify_linked", { feed_count: feeds.length });
                trackEvent("feed_activated", { app: "spotify", method: "open" });
                // One link covers the whole network — mark every show.
                markFeedsSetUp(feeds.map((f) => f.id));
              }}
            />
            <ul className="mt-10">
              {feeds.map((feed) => (
                <FeedBlock
                  key={feed.id}
                  feed={feed}
                  open={feed.id === openId}
                  onToggle={() =>
                    setOpenId(feed.id === openId ? null : feed.id)
                  }
                  onActivate={() => {
                    markFeedsSetUp([feed.id]);
                    advancePast(feed.id);
                  }}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

// How many shows are already in a podcast app, so a member with several can
// see at a glance what's left. A show counts once Beehiiv reports it activated
// or we've recorded the optimistic marker — see feedIsSetUp.
function SetupProgress({ feeds }: { feeds: UserFeed[] }) {
  const done = feeds.filter(feedIsSetUp).length;
  const total = feeds.length;
  const left = total - done;

  return (
    <div className="w-full shrink-0 border border-rule bg-navy-900/60 p-4 sm:w-[220px]">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label font-display font-bold text-fg-strong">
          {left === 0 ? "All set" : "Setup"}
        </span>
        <span className="font-display text-[15px] font-bold tracking-cta text-cyan">
          {done}
          <span className="text-fg-muted">/{total}</span>
        </span>
      </div>
      <div
        className="mt-3 h-1.5 w-full overflow-hidden bg-navy-800"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${done} of ${total} ${total === 1 ? "show" : "shows"} set up`}
      >
        <div
          className="h-full bg-cyan transition-[width] duration-700 ease-[cubic-bezier(.16,1,.3,1)]"
          style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
        />
      </div>
      <p className="mt-2.5 text-body-sm text-fg-muted">
        {left === 0
          ? total === 1
            ? "Your feed is in an app. Enjoy."
            : "You're following the whole network."
          : `${left} ${left === 1 ? "show" : "shows"} left to add.`}
      </p>
    </div>
  );
}

// Spotify first, and visually apart from the list: it's the only option that
// links an account rather than a device, so it needs no QR code and no
// per-show repetition.
//
// The hand-off is a same-tab round trip. Beehiiv now honours `redirect_path`
// (see buildSpotifyHandoff), so the member comes back carrying
// `?spotify=linked` and the panel below is the "now follow the show" half.
// A return that landed in a background tab would be worse than useless —
// OutboundLink defaults to `_blank`, so this has to override it.
function SpotifyRow({
  linked,
  onLink,
}: {
  /** Confirmed linked — the member came back carrying Beehiiv's marker. */
  linked: boolean;
  onLink: () => void;
}) {
  return (
    <div className="mt-10 border border-cyan/40 bg-cyan/[0.06]">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-6">
        <SpotifyIcon className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-h4 font-bold">Spotify</h3>
          <p className="mt-1 text-body-sm">
            Link your account once and every show in the network follows
            automatically — on every device you use.
          </p>
        </div>
        <OutboundLink
          href={SPOTIFY_HANDOFF_PATH}
          platform="spotify"
          placement="feed_setup"
          target="_self"
          rel="noreferrer"
          onClick={onLink}
          className="inline-flex shrink-0 items-center justify-center gap-2 bg-cyan px-5 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {linked ? "Link again" : "Link Spotify"}
          <span aria-hidden="true">→</span>
        </OutboundLink>
      </div>
      {linked ? <SpotifyFollowPanel /> : null}
    </div>
  );
}

// The second half of the Spotify path, shown once Beehiiv has sent the member
// back. Linking puts the feed in their Spotify; following it is what makes
// new episodes turn up on their own, and that is a step only they can take.
//
// It points at the library rather than at the show because a private feed has
// no show page — Open Access materialises each member's own feed inside their
// own account, and it never appears in Spotify's search (same reason the RSS
// row below says to look in the library once it's added).
function SpotifyFollowPanel() {
  return (
    <div
      role="status"
      className="border-t border-cyan/40 bg-navy-900/40 px-5 py-4"
    >
      <p className="text-body-sm text-fg-strong">
        Spotify is linked — your exclusive episodes are in Spotify now.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        <OutboundLink
          href={spotifyLibraryUrl}
          platform="spotify"
          placement="feed_setup_follow"
          className="button-text inline-flex shrink-0 items-center justify-center gap-2 border border-cyan px-4 py-2.5 font-display font-bold tracking-cta text-cyan transition hover:bg-cyan hover:text-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Find it in Spotify
          <span aria-hidden="true">→</span>
        </OutboundLink>
        <p className="min-w-0 text-body-sm text-fg-muted">
          It's in Your Library, under Podcasts — your feed is private, so it
          won't turn up in Spotify's search. Open it there and hit Follow.
        </p>
      </div>
    </div>
  );
}

// One show, collapsed to a single row until it's the one being worked on.
//
// Four premium shows turned this page into four identical five-row stacks, and
// the member's actual question — which of these have I still got to do? — was
// somewhere off the bottom of the screen. Collapsed, the whole checklist and
// its progress fit at a glance, and only the show in hand shows its apps.
//
// A disclosure rather than tabs on purpose: tabs would hide the checklist
// state behind a click each, and these titles don't survive a tab strip at
// phone width.
function FeedBlock({
  feed,
  open,
  onToggle,
  onActivate,
}: {
  feed: UserFeed;
  open: boolean;
  onToggle: () => void;
  onActivate: () => void;
}) {
  // Which app's QR code is open, if any. Desktop-only affordance, but the
  // state is harmless on a phone, where the toggle is never rendered.
  const [qrApp, setQrApp] = useState<App | null>(null);
  const handheld = useHandheld();
  const panelId = `${useId()}-feed`;

  const links = feed.protocolLinks ?? {};
  const apps = APPS.filter((a) => Boolean(links[a.protocolKey]));
  const done = feedIsSetUp(feed);

  return (
    <li className="-mt-px border border-rule">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center gap-4 p-4 text-left transition hover:bg-fg-strong/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
      >
        <span className="relative block aspect-square w-12 shrink-0 overflow-hidden bg-navy-900 shadow-cover ring-1 ring-rule">
          {feed.image_url ? (
            <img
              src={feed.image_url}
              alt=""
              width={96}
              height={96}
              className="h-full w-full object-cover"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center font-display text-xl font-bold text-cyan"
            >
              {feed.name.charAt(0)}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display font-bold tracking-[0.04em] text-fg-strong">
            {feed.name}
          </span>
          <span
            className={`mt-0.5 block text-body-sm ${done ? "text-cyan" : "text-fg-muted"}`}
          >
            {done ? "✓ Set up" : "Not in an app yet"}
          </span>
        </span>
        <Chevron open={open} />
      </button>

      {open ? (
        <div id={panelId} className="border-t border-rule px-4 pb-5 pt-1">
          {apps.length > 0 ? (
            <ul className="mt-4">
              {apps.map((app) => (
                <AppRow
                  key={app.key}
                  app={app}
                  url={links[app.protocolKey] as string}
                  feedUrl={feed.url}
                  handheld={handheld}
                  qrOpen={qrApp?.key === app.key}
                  onToggleQr={() => setQrApp(qrApp?.key === app.key ? null : app)}
                  onOpen={() => {
                    trackEvent("feed_activated", { app: app.key, method: "open" });
                    onActivate();
                  }}
                />
              ))}
            </ul>
          ) : null}

          <FeedUrlRow feed={feed} onActivate={onActivate} />
        </div>
      ) : null}
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className={`shrink-0 text-fg-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function AppRow({
  app,
  url,
  feedUrl,
  handheld,
  qrOpen,
  onToggleQr,
  onOpen,
}: {
  app: App;
  /** The app's own protocol link, e.g. `podcast://…`. */
  url: string;
  /** The plain https feed URL — what a desktop app's "add by URL" box wants. */
  feedUrl: string;
  handheld: boolean;
  qrOpen: boolean;
  onToggleQr: () => void;
  onOpen: () => void;
}) {
  const { Icon } = app;
  const panelId = `${useId()}-qr`;
  // Non-null only for apps with a desktop client — see APPS.
  const desktopBox = app.desktopBox;
  // Set once the member has used the desktop "open here" escape hatch, which
  // is the only moment the paste instruction is worth the space it takes.
  const [pasted, setPasted] = useState(false);

  const icon = Icon ? (
    <Icon className="size-7 shrink-0" />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-md bg-navy-900 font-display text-[13px] font-bold text-cyan ring-1 ring-rule"
    >
      {app.name.charAt(0)}
    </span>
  );
  const name = (
    <span className="min-w-0 flex-1 truncate text-left font-display font-bold tracking-[0.04em] text-fg-strong">
      {app.name}
    </span>
  );
  const rowClass =
    "group flex min-w-0 flex-1 items-center gap-3 p-4 transition hover:bg-fg-strong/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan";
  // The per-member feed URL is a bearer credential — whoever holds it can play
  // the paid shows. `ph-no-capture` is PostHog's own opt-out class and covers
  // both of its DOM collectors: autocapture drops clicks on the element (it
  // would otherwise send `attr__href`), and session replay swaps the element for
  // a blank box of the same size, attributes and all. Every element in this file
  // that renders, links or encodes the URL carries it; our own typed
  // `feed_activated` events still fire, and they never include the URL.

  return (
    <li className="-mt-px border border-rule">
      <div className="flex items-stretch">
        {handheld ? (
          /* The phone: the whole row is the tap target, and the link lands in
             the app with the feed already in it. */
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            onClick={onOpen}
            className={`${rowClass} ph-no-capture`}
          >
            {icon}
            {name}
            <span className="button-text shrink-0 text-fg-muted transition group-hover:text-cyan">
              Open <span aria-hidden="true">→</span>
            </span>
          </a>
        ) : (
          /* A computer: the QR is the action, because it moves the member to
             the device the app actually runs on. */
          <button
            type="button"
            onClick={onToggleQr}
            aria-expanded={qrOpen}
            aria-controls={panelId}
            className={rowClass}
          >
            {icon}
            {name}
            <span
              className={`button-text flex shrink-0 items-center gap-2 transition group-hover:text-cyan ${
                qrOpen ? "text-cyan" : "text-fg-muted"
              }`}
            >
              <QrIcon />
              {qrOpen ? "Hide code" : "Scan"}
            </span>
          </button>
        )}
        {!handheld && desktopBox && feedUrl ? (
          <a
            href={url}
            rel="noreferrer"
            onClick={() => {
              // The desktop app takes the FEED url, not the deep link — see the
              // note on `desktopBox`. Copy it on the way out so the box the app
              // opens is one paste from done. Same tab on purpose: a protocol
              // link in a new tab leaves an orphan tab sitting on `podcast://`.
              void navigator.clipboard?.writeText(feedUrl);
              setPasted(true);
              onOpen();
            }}
            className="ph-no-capture flex shrink-0 items-center border-l border-rule px-4 button-text text-fg-muted transition hover:bg-cyan/10 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
          >
            Open here
          </a>
        ) : null}
      </div>
      {pasted && desktopBox ? (
        <p
          role="status"
          className="border-t border-rule bg-navy-900/40 px-4 py-3 text-body-sm"
        >
          {app.name} opens its “{desktopBox}” box empty on a computer — your
          feed URL is on the clipboard, so paste it in there.
        </p>
      ) : null}
      {qrOpen ? <QrPanel id={panelId} appName={app.name} url={url} /> : null}
    </li>
  );
}

// The QR encodes the app's own deep link, so scanning it hands the phone
// exactly what tapping the row would — no sign-in on the second device, and
// nothing for the member to copy across.
function QrPanel({
  id,
  appName,
  url,
}: {
  id: string;
  appName: string;
  url: string;
}) {
  const [dataUrl, setDataUrl] = useState("");

  // A row's panel mounts when it opens and unmounts when it closes, so `url`
  // never changes under a mounted panel — one generation per open.
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, {
      width: 512,
      margin: 1,
      color: { dark: "#0a1624", light: "#ffffff" },
    })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        /* nothing renders until there's a code to render */
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (!dataUrl) return null;

  return (
    <div
      id={id}
      className="flex items-center gap-6 border-t border-rule bg-navy-900/40 p-5"
    >
      {/* The QR *is* the feed URL — a replay frame of it can be scanned. */}
      <div className="ph-no-capture size-32 shrink-0 bg-white p-2">
        <img
          src={dataUrl}
          alt={`QR code that opens ${appName} on your phone`}
          width={128}
          height={128}
          className="block h-full w-full"
        />
      </div>
      <p className="min-w-0 text-body-sm">
        Point your phone's camera at this code to add the show to {appName}{" "}
        there.
      </p>
    </div>
  );
}

// The universal fallback: the raw RSS URL, for any app not listed above.
function FeedUrlRow({
  feed,
  onActivate,
}: {
  feed: UserFeed;
  onActivate: () => void;
}) {
  const { copied, copy } = useCopyToClipboard();
  const [emailState, setEmailState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [emailError, setEmailError] = useState<string | null>(null);

  if (!feed.url) {
    return (
      <p className="mt-6 text-body-sm">
        No feed URL for this show yet — give it a minute and refresh.
      </p>
    );
  }

  const sendEmail = async () => {
    if (emailState === "sending") return;
    setEmailState("sending");
    setEmailError(null);
    const result = await sendFeedEmail(feed.id);
    if (result.ok) {
      setEmailState("sent");
      trackEvent("feed_activated", { app: "email", method: "email" });
      onActivate();
    } else {
      setEmailState("error");
      setEmailError(result.error ?? "Could not send the email.");
    }
  };

  return (
    <div className="mt-6">
      <p className="label font-display font-bold text-fg-faint">
        Any other app
      </p>
      <div className="mt-3 flex items-stretch border border-rule bg-navy-900/60">
        <span
          title={feed.url}
          className="ph-no-capture min-w-0 flex-1 truncate px-4 py-3 font-mono text-body-sm"
        >
          {feed.url}
        </span>
        <button
          type="button"
          onClick={() =>
            void copy(feed.url, () => {
              trackEvent("feed_activated", { app: "manual", method: "copy" });
              onActivate();
            })
          }
          aria-label={
            copied
              ? "Feed URL copied to clipboard"
              : "Copy feed URL to clipboard"
          }
          className="flex shrink-0 items-center gap-2 border-l border-rule px-4 py-3 button-text font-display font-bold tracking-[0.12em] text-fg-muted transition hover:bg-cyan/10 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <p className="mt-3 text-body-sm">
        Paste it into any podcast app's "add by URL" option. A private feed
        never turns up in an app's search — look in your library once it's
        added.{" "}
        {emailState === "sent" ? (
          <span role="status" className="text-cyan">
            Sent — check your inbox.
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void sendEmail()}
            disabled={emailState === "sending"}
            className="underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            {emailState === "sending" ? "Sending…" : "Or email it to yourself."}
          </button>
        )}
      </p>
      {emailState === "error" && emailError ? (
        <p role="alert" className="mt-2 text-body-sm text-danger">
          {emailError}
        </p>
      ) : null}
    </div>
  );
}

function QrIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M5 12.5 10 17.5 19 6.5" />
    </svg>
  );
}
