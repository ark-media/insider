import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Breadcrumbs } from "./Breadcrumbs";
import {
  ApplePodcastsIcon,
  DowncastIcon,
  OvercastIcon,
  PocketCastsIcon,
  SpotifyIcon,
} from "./PlatformIcons";
import { sendFeedEmail, type UserFeed } from "../lib/auth";
import { trackEvent } from "../lib/analytics";
import { useCopyToClipboard } from "../lib/useCopyToClipboard";
import { useSubscriberAuth } from "../lib/subscriberAuth";

type Device = "phone" | "computer";

type AppKey =
  | "apple"
  | "spotify"
  | "overcast"
  | "pocketcasts"
  | "castro"
  | "downcast"
  | "manual";

// Server route that mints Beehiiv's auto-login and 302s the member into
// Beehiiv's Spotify consent flow, which returns them here when it's done.
// Open Access verifies the click originated on Beehiiv, so there is no direct
// Spotify URL we can link — and because the round trip comes back to us, this
// one opens in the same tab rather than a new one.
const SPOTIFY_HANDOFF_PATH = "/api/me/feeds/spotify";

type AppDef = {
  key: AppKey;
  name: string;
  tagline: string;
  devices: Device[];
  // Which Beehiiv `protocol_links` key to use. If omitted, we fall back to the
  // plain feed URL (the copy-paste apps).
  protocolKey?: string;
  /** Goes through our own server route rather than a feed URL. */
  handoffPath?: string;
  instructions: string[];
  ctaLabel: string;
  note?: string;
};

const APPS: AppDef[] = [
  {
    key: "spotify",
    name: "Spotify",
    tagline: "Link once — no copy-paste",
    devices: ["phone", "computer"],
    handoffPath: SPOTIFY_HANDOFF_PATH,
    instructions: [
      "We'll send you straight to Spotify — you're already signed in on our side.",
      "Sign in to Spotify and approve the connection.",
      "You'll come back here, and {show} unlocks inside Spotify.",
    ],
    ctaLabel: "Link my Spotify account",
  },
  {
    key: "apple",
    name: "Apple Podcasts",
    tagline: "iPhone, iPad, Mac",
    devices: ["phone", "computer"],
    protocolKey: "apple",
    instructions: [
      "The Podcasts app will open on your device.",
      "A pop-up will appear with the show URL — tap Follow.",
      "Your exclusive {show} episodes appear here. Your other feeds stay where they are.",
    ],
    ctaLabel: "Open in Apple Podcasts",
    note: "Can't find the show? Don't search for it — a private feed never appears in Apple Podcasts search. Go to Library → Shows to find it there.",
  },
  {
    key: "overcast",
    name: "Overcast",
    tagline: "iPhone",
    devices: ["phone"],
    protocolKey: "overcast",
    instructions: [
      "Overcast will open on your phone.",
      "Confirm the prompt to add the private feed.",
      "Your exclusive {show} episodes appear in your library.",
    ],
    ctaLabel: "Open in Overcast",
  },
  {
    key: "pocketcasts",
    name: "Pocket Casts",
    tagline: "iPhone & Android",
    devices: ["phone"],
    protocolKey: "pocket_casts",
    instructions: [
      "Pocket Casts will open on your phone.",
      "Confirm the prompt to add the private feed.",
      "Your exclusive {show} episodes appear in your library.",
    ],
    ctaLabel: "Open in Pocket Casts",
  },
  {
    key: "castro",
    name: "Castro",
    tagline: "iPhone",
    devices: ["phone"],
    protocolKey: "castro",
    instructions: [
      "Castro will open on your phone.",
      "Confirm the prompt to add the private feed.",
      "Your exclusive {show} episodes appear in your library.",
    ],
    ctaLabel: "Open in Castro",
  },
  {
    key: "downcast",
    name: "Downcast",
    tagline: "iPhone",
    devices: ["phone"],
    instructions: [
      "Open Downcast and go to the Podcasts tab.",
      "Tap Add Podcast → Add Podcast by URL.",
      "Paste the private feed URL below.",
    ],
    ctaLabel: "Copy feed URL",
  },
  {
    key: "manual",
    name: "Another app — I'll add the feed manually",
    tagline: "Any podcast player",
    devices: ["phone", "computer"],
    instructions: [
      "Open the podcast app you want to listen in.",
      "Find the option to add a podcast by URL (sometimes under Settings → Advanced).",
      "Paste the private feed URL below.",
    ],
    ctaLabel: "Copy feed URL",
  },
];

function feedAppUrl(feed: UserFeed | null, app: AppDef | null): string {
  if (!app) return "";
  if (app.handoffPath) return app.handoffPath;
  if (!feed) return "";
  if (app.protocolKey) {
    const match = feed.protocolLinks?.[app.protocolKey];
    if (match) return match;
  }
  return feed.url;
}

export function SetupFlow({
  feed,
  onBack,
  embedded = false,
  spotifyLinked = false,
}: {
  feed: UserFeed | null;
  // When set, the member has more than one feed; render a link back to the
  // feed picker instead of the (too-subtle) inline switcher.
  onBack?: () => void;
  /** Rendered inside the /account shell — see FeedSetupHub's note. */
  embedded?: boolean;
  /**
   * The member has just come back from Beehiiv's Spotify consent flow. The
   * page they return to is otherwise identical to the one they left, so say
   * plainly that it worked.
   */
  spotifyLinked?: boolean;
}) {
  const { markFeedsSetUp } = useSubscriberAuth();
  const feedUrl = feed?.url ?? "";
  const showName = feed?.name ?? "your show";

  const [device, setDevice] = useState<Device | null>(null);
  const [appKey, setAppKey] = useState<AppKey | null>(null);
  const { copied, copy } = useCopyToClipboard();

  // On small screens, skip the device question (per mobile Figma)
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const apply = (matches: boolean) => {
      if (matches) setDevice((d) => d ?? "phone");
    };
    apply(mql.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const visibleApps = useMemo(() => {
    const available = new Set(Object.keys(feed?.protocolLinks ?? {}));
    // Hide any app whose deep link Beehiiv didn't return — our link would fall
    // back to the raw RSS URL, which most of those apps can't open. Apps with
    // no protocol key ("manual", "downcast") and the Spotify hand-off (which
    // goes through our own route, not a feed link) are always shown.
    return APPS.filter((a) => {
      if (device && !a.devices.includes(device)) return false;
      if (a.protocolKey && !available.has(a.protocolKey)) return false;
      return true;
    });
  }, [device, feed]);

  const selectedApp = useMemo(
    () => APPS.find((a) => a.key === appKey) ?? null,
    [appKey],
  );

  const copyFeed = () => {
    if (!feedUrl) return;
    void copy(feedUrl, () => {
      trackEvent("feed_activated", { app: appKey ?? "unknown", method: "copy" });
      if (feed) markFeedsSetUp([feed.id]);
    });
  };

  const selectedAppUrl = feedAppUrl(feed, selectedApp);
  const qrTarget = selectedAppUrl || feedUrl;

  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  useEffect(() => {
    if (!qrTarget) return;
    let cancelled = false;
    QRCode.toDataURL(qrTarget, {
      width: 512,
      margin: 1,
      color: { dark: "#0a1624", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [qrTarget]);

  const [emailState, setEmailState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [emailError, setEmailError] = useState<string | null>(null);

  const handleSendEmail = async () => {
    if (emailState === "sending") return;
    setEmailState("sending");
    setEmailError(null);
    const result = await sendFeedEmail();
    if (result.ok) {
      setEmailState("sent");
      trackEvent("feed_activated", { app: appKey ?? "unknown", method: "email" });
      if (feed) markFeedsSetUp([feed.id]);
    } else {
      setEmailState("error");
      setEmailError(result.error ?? "Could not send the email.");
    }
  };

  const Frame = embedded ? "section" : "main";

  return (
    <Frame className="relative text-fg-strong">
      <div
        className={
          embedded
            ? "mx-auto max-w-[1040px] px-6 pb-16 pt-10 sm:px-10"
            : "mx-auto max-w-[1040px] px-6 pb-24 pt-8 sm:px-10 sm:pb-28"
        }
      >
        {embedded ? null : (
          <Breadcrumbs
            items={[
              { label: "Home", to: "/" },
              { label: "Account", to: "/account" },
              { label: "Podcast feed" },
            ]}
            className="mb-10"
          />
        )}
        {/* When the member has more than one private feed, link back to the
            feed picker rather than switching shows inline. */}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="rise rise-1 group mb-10 inline-flex items-center gap-2 text-body-sm text-fg-muted transition hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:-translate-x-1">
              ←
            </span>
            All feeds
          </button>
        ) : null}
        {spotifyLinked ? (
          <div
            role="status"
            className="rise rise-1 mb-10 flex items-start gap-3 border border-cyan/40 bg-cyan/10 px-5 py-4 text-body-sm text-fg-strong"
          >
            <span aria-hidden="true" className="font-display font-bold text-cyan">
              ✓
            </span>
            <p>
              Spotify is linked. Open {showName} in Spotify — your exclusive
              episodes are there now.
            </p>
          </div>
        ) : null}
        {/* Masthead row */}
        <div className="rise rise-1 flex flex-col items-start gap-6 sm:flex-row sm:items-end sm:gap-8">
          <div
            className="relative aspect-square w-[140px] shrink-0 overflow-hidden bg-navy-900 shadow-cover sm:w-[164px]"
            style={{ transform: "rotate(-1.5deg)" }}
          >
            {feed?.image_url ? (
              <img
                src={feed.image_url}
                alt={showName}
                width={760}
                height={760}
                className="h-full w-full object-cover"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex h-full w-full items-center justify-center font-display text-4xl font-bold text-cyan"
              >
                {showName.charAt(0)}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="label flex items-center gap-3 text-cyan">
              <span className="h-px w-10 bg-cyan" />
              You're in
            </div>
            <h1 className="mt-5 text-fg-strong">
              <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
                Now let's get you
              </span>
              <span className="display-upright block text-[clamp(1.9rem,4.2vw,3.4rem)]">
                <span className="display text-cyan">listening.</span>
              </span>
            </h1>
            <p className="mt-5 max-w-md text-body-lg">
              Get your exclusive {showName} episodes in your podcast app of
              choice — in just a few steps.
            </p>
          </div>
        </div>

        <div className="mt-12 hairline" />

        {/* Step 1 — Device */}
        <Section
          number={1}
          title="Choose what device you want to listen on"
          subtitle="Skip this on a phone — we'll assume you want the phone flow."
          active={device === null}
          done={device !== null}
          hiddenOnMobile
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DeviceCard
              icon={<PhoneIcon />}
              label="On my phone"
              hint="Open or scan to add to your podcast app"
              selected={device === "phone"}
              onClick={() => {
                setDevice("phone");
                setAppKey(null);
              }}
            />
            <DeviceCard
              icon={<MonitorIcon />}
              label="On my computer"
              hint="Open in Spotify, Apple Podcasts, or similar"
              selected={device === "computer"}
              onClick={() => {
                setDevice("computer");
                setAppKey(null);
              }}
            />
          </div>
        </Section>

        <div className="mt-12 hairline hidden md:block" />

        {/* Step 2 — App */}
        <Section
          number={2}
          mobileNumber={1}
          title="Choose where you listen to your podcasts"
          subtitle={
            device === "computer"
              ? "These three work directly in your browser or desktop app."
              : "Pick the app you already use — we'll send you straight there."
          }
          active={device !== null && appKey === null}
          done={appKey !== null}
          dimmed={device === null}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
            {visibleApps
              .filter((a) => a.key !== "manual")
              .map((app) => (
                <AppCard
                  key={app.key}
                  app={app}
                  selected={appKey === app.key}
                  featured={app.key === "spotify"}
                  onClick={() => {
                    trackEvent("feed_app_selected", { app: app.key });
                    setAppKey(app.key);
                  }}
                />
              ))}
          </div>
          {visibleApps.some((a) => a.key === "manual") ? (
            <button
              type="button"
              onClick={() => {
                trackEvent("feed_app_selected", { app: "manual" });
                setAppKey("manual");
              }}
              className={`mt-3 w-full border px-4 py-3 text-left text-body-sm transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:text-center ${
                appKey === "manual"
                  ? "border-cyan bg-cyan/10 text-fg-strong"
                  : "border-rule text-fg hover:border-cyan/60 hover:text-fg-strong"
              }`}
            >
              Another app — I'll add the feed manually
            </button>
          ) : null}
        </Section>

        <div className="mt-12 hairline" />

        {/* Step 3 — Instructions */}
        <Section
          number={3}
          mobileNumber={2}
          title="Start listening"
          subtitle={
            selectedApp
              ? `Here's how to finish setting up ${selectedApp.name}.`
              : "Pick an app above to see your instructions."
          }
          active={selectedApp !== null}
          dimmed={selectedApp === null}
        >
          {selectedApp ? (
            <div className="rise rise-1 space-y-6">
              <ol className="space-y-3 border border-rule bg-navy-800/60 p-6 text-body-sm text-fg sm:text-body">
                {selectedApp.instructions.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="text-body-sm font-display font-bold text-cyan">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{step.replace(/\{show\}/g, showName)}</span>
                  </li>
                ))}
              </ol>

              <div className="flex flex-wrap items-center gap-4">
                {selectedApp.ctaLabel.startsWith("Copy") ? (
                  <button
                    type="button"
                    onClick={copyFeed}
                    className="group inline-flex items-center gap-3 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    {copied ? "Copied ✓" : selectedApp.ctaLabel}
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                      →
                    </span>
                  </button>
                ) : (
                  <a
                    href={selectedAppUrl || feedUrl}
                    // The hand-off returns the member to this page, so keep it
                    // in the same tab; everything else is a jump out to an app.
                    target={selectedApp.handoffPath ? undefined : "_blank"}
                    rel={selectedApp.handoffPath ? undefined : "noreferrer"}
                    onClick={() => {
                      trackEvent("feed_activated", {
                        app: selectedApp.key,
                        method: "open",
                      });
                      if (feed) markFeedsSetUp([feed.id]);
                    }}
                    className="group inline-flex items-center gap-3 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    {selectedApp.ctaLabel}
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                      →
                    </span>
                  </a>
                )}

                <button
                  type="button"
                  onClick={copyFeed}
                  className="text-body-sm underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  {copied ? "Feed URL copied" : "Or copy the raw feed URL"}
                </button>
              </div>

              {qrTarget && qrDataUrl ? (
                <QrHandoff
                  appName={selectedApp.name}
                  manual={selectedApp.key === "manual"}
                  dataUrl={qrDataUrl}
                  target={qrTarget}
                  mode={device ?? "computer"}
                />
              ) : null}

              {feedUrl ? (
                <EmailHandoff
                  state={emailState}
                  error={emailError}
                  onSend={handleSendEmail}
                  onReset={() => {
                    setEmailState("idle");
                    setEmailError(null);
                  }}
                />
              ) : null}

              {feedUrl ? (
                <CopyableUrl url={feedUrl} />
              ) : (
                <div className="border border-rule bg-navy-900/60 p-4 font-mono text-body-sm ">
                  No feed available for this membership yet.
                </div>
              )}

              {selectedApp.note ? (
                <div className="border-l-2 border-signal/70 bg-signal/10 p-4 text-body-sm text-fg">
                  <span className="mr-1 font-semibold text-danger">Note —</span>
                  {selectedApp.note}
                </div>
              ) : null}
            </div>
          ) : null}
        </Section>
      </div>
    </Frame>
  );
}

function Section({
  number,
  mobileNumber,
  title,
  subtitle,
  active,
  done,
  dimmed,
  hiddenOnMobile,
  children,
}: {
  number: number;
  /** Step number shown below `md`, where the device step is hidden and the
   *  sequence would otherwise start at 2. Both render; CSS picks one, so the
   *  numbering can't disagree with `hiddenOnMobile` the way a JS breakpoint
   *  check would before the media query resolves. */
  mobileNumber?: number;
  title: string;
  subtitle: string;
  active?: boolean;
  done?: boolean;
  dimmed?: boolean;
  hiddenOnMobile?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`mt-12 transition-opacity ${dimmed ? "opacity-40" : "opacity-100"} ${
        hiddenOnMobile ? "hidden md:block" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span
          className={`label font-display font-bold ${
            done ? "text-cyan/70" : active ? "text-cyan" : "text-fg-faint"
          }`}
        >
          Step{" "}
          {mobileNumber !== undefined ? (
            <>
              <span className="md:hidden">{mobileNumber}</span>
              <span className="hidden md:inline">{number}</span>
            </>
          ) : (
            number
          )}
          {done ? " ✓" : ""}
        </span>
        <h2 className="text-fg-strong">
          <span className="display-upright text-[clamp(1.3rem,2.6vw,1.9rem)]">
            {title}
          </span>
        </h2>
      </div>
      <p className="mt-2 max-w-xl text-body-sm">{subtitle}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function DeviceCard({
  icon,
  label,
  hint,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex flex-col items-center gap-3 border p-8 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        selected
          ? "border-cyan bg-cyan/10"
          : "border-rule hover:border-cyan/60 hover:bg-fg-strong/[0.03]"
      }`}
    >
      <span
        className={`transition ${selected ? "text-cyan" : "text-fg-muted group-hover:text-cyan"}`}
      >
        {icon}
      </span>
      <span className="label font-display font-bold tracking-cta text-fg-strong">
        {label}
      </span>
      <span className="text-body-sm">{hint}</span>
    </button>
  );
}

// Full-color brand marks, matching the show page's "listen on" row. The
// "manual" option keeps the lettered-tile fallback (it isn't a single app).
const BRAND_ICON: Partial<
  Record<AppKey, (props: { className?: string }) => React.JSX.Element>
> = {
  apple: ApplePodcastsIcon,
  spotify: SpotifyIcon,
  overcast: OvercastIcon,
  pocketcasts: PocketCastsIcon,
  downcast: DowncastIcon,
};

function AppCard({
  app,
  selected,
  featured = false,
  onClick,
}: {
  app: AppDef;
  selected: boolean;
  featured?: boolean;
  onClick: () => void;
}) {
  const Icon = BRAND_ICON[app.key];
  const iconSize = featured ? "size-10" : "size-7";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-2 border text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        featured ? "col-span-2 p-5" : "p-4"
      } ${
        selected
          ? "border-cyan bg-cyan/10"
          : "border-rule hover:border-cyan/60 hover:bg-fg-strong/[0.03]"
      }`}
    >
      {featured ? (
        <span className="inline-flex items-center rounded-full bg-cyan/15 px-2.5 py-1 label font-display font-bold tracking-[0.08em] text-cyan">
          Easiest setup
        </span>
      ) : null}
      <span className="flex items-center gap-2.5">
        {Icon ? (
          <Icon className={`${iconSize} shrink-0`} />
        ) : (
          <span
            aria-hidden="true"
            className={`flex ${iconSize} shrink-0 items-center justify-center rounded-md bg-navy-900 text-[13px] font-display font-bold text-cyan ring-1 ring-rule`}
          >
            {app.name.charAt(0)}
          </span>
        )}
        <span
          className={`font-display font-bold tracking-[0.06em] text-fg-strong ${
            featured ? "text-body" : "label"
          }`}
        >
          {app.name}
        </span>
      </span>
      <span className="meta">
        {app.tagline}
      </span>
    </button>
  );
}

function CopyableUrl({ url }: { url: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="flex items-stretch border border-rule bg-navy-900/60">
      <span
        title={url}
        className="min-w-0 flex-1 truncate px-4 py-3 font-mono text-body-sm "
      >
        {url}
      </span>
      <button
        type="button"
        onClick={() => void copy(url)}
        aria-label={
          copied ? "Feed URL copied to clipboard" : "Copy feed URL to clipboard"
        }
        className="flex shrink-0 items-center gap-2 border-l border-rule px-4 py-3 button-text font-display font-bold tracking-[0.12em] text-fg-muted transition hover:bg-cyan/10 hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

function QrHandoff({
  appName,
  manual,
  dataUrl,
  target,
  mode,
}: {
  appName: string;
  manual: boolean;
  dataUrl: string;
  target: string;
  mode: Device;
}) {
  const eyebrow =
    mode === "phone" ? "Continue on another device" : "Continue on phone";
  const heading = manual ? "Scan to open the setup link" : `Scan to open ${appName}`;
  const body =
    mode === "phone"
      ? "On another device, point its camera at this code to open the setup link there."
      : manual
        ? "Point your phone's camera at this code. It'll open the setup link on your phone, ready to add in your podcast app."
        : `Point your phone's camera at this code. It'll open the setup link on your phone so you can finish in the ${appName} app.`;
  return (
    <div className="flex flex-col gap-5 border border-rule bg-navy-900/40 p-6 sm:flex-row sm:items-start sm:gap-8">
      <div className="bg-white p-3 shrink-0">
        <img
          src={dataUrl}
          alt="QR code for the setup link"
          width={144}
          height={144}
          className="block size-36 sm:size-40"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 label text-cyan">
          <span className="h-px w-6 bg-cyan" />
          {eyebrow}
        </div>
        <h3 className="mt-3 font-display text-[17px] font-bold uppercase tracking-[0.04em] text-fg-strong">
          {heading}
        </h3>
        <p className="mt-2 text-body-sm">{body}</p>
        <div className="mt-4">
          <CopyableUrl url={target} />
        </div>
      </div>
    </div>
  );
}

function EmailHandoff({
  state,
  error,
  onSend,
  onReset,
}: {
  state: "idle" | "sending" | "sent" | "error";
  error: string | null;
  onSend: () => void;
  onReset: () => void;
}) {
  return (
    <div className="border border-rule bg-navy-900/40 p-6">
      <div className="flex items-center gap-3 label text-cyan">
        <span className="h-px w-6 bg-cyan" />
        Email me the setup link
      </div>
      <p className="mt-2 text-body-sm">
        We'll email your private feed link and setup instructions to the address
        on your membership. Useful if you'd rather finish this on another
        device.
      </p>

      {state === "sent" ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center justify-between gap-4 border border-cyan/40 bg-cyan/10 p-4"
        >
          <p className="text-body-sm text-fg-strong">
            Sent. Check your inbox — open the link to finish setup.
          </p>
          <button
            type="button"
            onClick={onReset}
            className="text-body-sm underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Send another
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onSend}
          disabled={state === "sending"}
          aria-busy={state === "sending"}
          className="group mt-4 inline-flex items-center justify-center gap-3 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {state === "sending" ? "Sending..." : "Email me the link"}
          <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
            →
          </span>
        </button>
      )}

      {state === "error" && error ? (
        <p role="alert" className="mt-3 text-body-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <line x1="11" y1="18" x2="13" y2="18" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="4" width="20" height="13" rx="1.5" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V5a1.5 1.5 0 0 1 1.5-1.5H15" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12.5 10 17.5 19 6.5" />
    </svg>
  );
}
