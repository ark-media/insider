import { useEffect, useId, useState } from "react";
import QRCode from "qrcode";
import {
  ApplePodcastsIcon,
  OvercastIcon,
  PocketCastsIcon,
  SpotifyIcon,
} from "./PlatformIcons";
import { OutboundLink } from "./OutboundLink";
import { feedIsSetUp, sendFeedEmail, type UserFeed } from "../lib/auth";
import { trackEvent } from "../lib/analytics";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { useSubscriberAuth } from "../lib/subscriberAuth";

// Server route that mints Beehiiv's auto-login and 302s the member into
// Beehiiv's Spotify consent flow, which returns them here when it's done.
// Open Access verifies the click originated on Beehiiv, so there is no direct
// Spotify URL we can link — and because the round trip comes back to us, this
// one opens in the same tab rather than a new one.
const SPOTIFY_HANDOFF_PATH = "/api/me/feeds/spotify";

// The apps we can hand off to with one tap, in the order they're listed.
// `protocolKey` is the key in Beehiiv's `protocol_links`; an app whose key
// Beehiiv didn't return for a feed is dropped, because our only fallback would
// be the raw RSS URL, which none of these apps can open. Everything else is
// served by the "copy the feed URL" row at the bottom.
const APPS = [
  { key: "apple", name: "Apple Podcasts", protocolKey: "apple", Icon: ApplePodcastsIcon },
  { key: "overcast", name: "Overcast", protocolKey: "overcast", Icon: OvercastIcon },
  { key: "pocketcasts", name: "Pocket Casts", protocolKey: "pocket_casts", Icon: PocketCastsIcon },
  { key: "castro", name: "Castro", protocolKey: "castro", Icon: null },
] as const;

type App = (typeof APPS)[number];

/**
 * Private-feed setup: a flat list of deep links, one tap each.
 *
 * The shape of this page follows the shape of the job. On a phone the member
 * is already holding the device the podcast app lives on, so every row is just
 * a link they tap. On a desktop the same tap can't reach their phone, so each
 * row also offers a QR code of that app's link. Spotify stays first and set
 * apart: it links the account rather than a device, so it's the one path that
 * finishes wherever it's started and covers every show at once.
 */
export function FeedSetup({
  feeds,
  spotifyLinked = false,
}: {
  feeds: UserFeed[];
  /** The member has just come back from Beehiiv's Spotify consent flow. */
  spotifyLinked?: boolean;
}) {
  const { markFeedsSetUp } = useSubscriberAuth();

  return (
    <section>
      <div className="page-section">
        {spotifyLinked ? (
          <div
            role="status"
            className="mb-10 flex items-start gap-3 border border-cyan/40 bg-cyan/10 px-5 py-4 text-body-sm text-fg-strong"
          >
            <span aria-hidden="true" className="font-display font-bold text-cyan">
              ✓
            </span>
            <p>
              Spotify is linked. Your exclusive episodes are in Spotify now —
              look for the show in Your Library.
            </p>
          </div>
        ) : null}

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
            No private feeds on your membership yet. If you just joined, give it
            a minute and refresh — they appear here automatically.
          </div>
        ) : (
          <>
            <SpotifyRow
              onLink={() => {
                trackEvent("feed_spotify_linked", { feed_count: feeds.length });
                trackEvent("feed_activated", { app: "spotify", method: "open" });
                // One link covers the whole network — mark every show.
                markFeedsSetUp(feeds.map((f) => f.id));
              }}
            />
            {feeds.map((feed) => (
              <FeedBlock
                key={feed.id}
                feed={feed}
                onActivate={() => markFeedsSetUp([feed.id])}
              />
            ))}
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
function SpotifyRow({ onLink }: { onLink: () => void }) {
  return (
    <div className="mt-10 flex flex-col gap-5 border border-cyan/40 bg-cyan/[0.06] p-5 sm:flex-row sm:items-center sm:gap-6">
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
        // The hand-off comes back to this page, so keep it in the same tab.
        target="_self"
        rel="noreferrer"
        onClick={onLink}
        className="inline-flex shrink-0 items-center justify-center gap-2 bg-cyan px-5 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      >
        Link Spotify
        <span aria-hidden="true">→</span>
      </OutboundLink>
    </div>
  );
}

function FeedBlock({
  feed,
  onActivate,
}: {
  feed: UserFeed;
  onActivate: () => void;
}) {
  // Which app's QR code is open, if any. Desktop-only affordance, but the
  // state is harmless on a phone, where the toggle is never rendered.
  const [qrApp, setQrApp] = useState<App | null>(null);

  const links = feed.protocolLinks ?? {};
  const apps = APPS.filter((a) => Boolean(links[a.protocolKey]));

  return (
    <div className="mt-12">
      <div className="flex items-center gap-4">
        <div className="relative aspect-square w-14 shrink-0 overflow-hidden bg-navy-900 shadow-cover ring-1 ring-rule">
          {feed.image_url ? (
            <img
              src={feed.image_url}
              alt=""
              width={112}
              height={112}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-full w-full items-center justify-center font-display text-xl font-bold text-cyan"
            >
              {feed.name.charAt(0)}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="text-h4 truncate font-bold">{feed.name}</h3>
          {feedIsSetUp(feed) ? (
            <p className="mt-1 text-body-sm text-cyan">✓ Set up</p>
          ) : null}
        </div>
      </div>

      {apps.length > 0 ? (
        <ul className="mt-5">
          {apps.map((app) => (
            <AppRow
              key={app.key}
              app={app}
              url={links[app.protocolKey] as string}
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
  );
}

function AppRow({
  app,
  url,
  qrOpen,
  onToggleQr,
  onOpen,
}: {
  app: App;
  url: string;
  qrOpen: boolean;
  onToggleQr: () => void;
  onOpen: () => void;
}) {
  const { Icon } = app;
  const panelId = `${useId()}-qr`;
  return (
    <li className="-mt-px border border-rule">
      <div className="flex items-stretch">
        {/* The whole row is the tap target — this is the mobile flow. */}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={onOpen}
          className="group flex min-w-0 flex-1 items-center gap-3 p-4 transition hover:bg-fg-strong/[0.03] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
        >
          {Icon ? (
            <Icon className="size-7 shrink-0" />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-navy-900 font-display text-[13px] font-bold text-cyan ring-1 ring-rule"
            >
              {app.name.charAt(0)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate font-display font-bold tracking-[0.04em] text-fg-strong">
            {app.name}
          </span>
          <span className="button-text shrink-0 text-fg-muted transition group-hover:text-cyan">
            Open <span aria-hidden="true">→</span>
          </span>
        </a>
        {/* Desktop only: a phone-only app can't be opened from here, and even
            Apple's desktop app isn't where most people listen. */}
        <button
          type="button"
          onClick={onToggleQr}
          aria-expanded={qrOpen}
          aria-controls={panelId}
          aria-label={`${qrOpen ? "Hide" : "Show"} QR code for ${app.name}`}
          className={`hidden shrink-0 items-center gap-2 border-l border-rule px-4 button-text transition hover:bg-cyan/10 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan md:flex ${
            qrOpen ? "bg-cyan/10 text-cyan" : "text-fg-muted"
          }`}
        >
          <QrIcon />
          Scan
        </button>
      </div>
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
      className="hidden items-center gap-6 border-t border-rule bg-navy-900/40 p-5 md:flex"
    >
      <div className="size-32 shrink-0 bg-white p-2">
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
    const result = await sendFeedEmail();
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
          className="min-w-0 flex-1 truncate px-4 py-3 font-mono text-body-sm"
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
