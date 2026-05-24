import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import QRCode from "qrcode";
import { ArkLogo } from "./ArkLogo";
import {
  cancelSubscription,
  sendSetupSms,
  type Me,
  type UserFeed,
} from "../lib/auth";
import { useSubscriberAuth } from "../lib/subscriberAuth";

type Device = "phone" | "computer";

type AppKey =
  | "apple"
  | "spotify"
  | "youtube"
  | "overcast"
  | "pocketcasts"
  | "downcast"
  | "manual";

type AppDef = {
  key: AppKey;
  name: string;
  tagline: string;
  devices: Device[];
  // Which Supporting Cast `feed.apps[].app` identifier to map to. If
  // omitted, we fall back to the plain feed URL.
  scApp?: string;
  instructions: string[];
  ctaLabel: string;
  note?: string;
};

const APPS: AppDef[] = [
  {
    key: "apple",
    name: "Apple Podcasts",
    tagline: "iPhone, iPad, Mac",
    devices: ["phone", "computer"],
    scApp: "apple_podcasts",
    instructions: [
      "The Podcasts app will open on your device.",
      "A pop-up will appear with the show URL — tap Follow.",
      "Listen to your exclusive Inside episodes each Friday. Regular Call Me Back episodes stay in your existing feed.",
    ],
    ctaLabel: "Open in Apple Podcasts",
    note: "Can't find the show? Don't search for it. This private feed won't appear in the Apple Podcasts search. Go to Library → Shows to find Inside Call Me Back (white cover — not the purple one).",
  },
  {
    key: "spotify",
    name: "Spotify",
    tagline: "Phone or desktop",
    devices: ["phone", "computer"],
    scApp: "spotify",
    instructions: [
      "A separate window will open — click Link Account.",
      "Sign in to your Spotify account.",
      "Inside Call Me Back episodes will be unlocked inside your Call Me Back show on Spotify.",
    ],
    ctaLabel: "Link my Spotify account",
  },
  {
    key: "youtube",
    name: "YouTube Music",
    tagline: "Phone or desktop",
    devices: ["phone", "computer"],
    scApp: "youtube_music",
    instructions: [
      "YouTube Music will open — sign in if you're not already.",
      "A pop-up will appear with the show URL — tap Add.",
      "Your exclusive episodes will appear in your Call Me Back library each Friday.",
    ],
    ctaLabel: "Open in YouTube Music",
    note: "Heads up: there are no videos for Inside Call Me Back — audio only.",
  },
  {
    key: "overcast",
    name: "Overcast",
    tagline: "iPhone",
    devices: ["phone"],
    scApp: "overcast",
    instructions: [
      "Open Overcast on your phone.",
      "Tap the + icon, then Add URL.",
      "Paste the private feed URL below.",
    ],
    ctaLabel: "Copy feed URL",
  },
  {
    key: "pocketcasts",
    name: "Pocket Casts",
    tagline: "iPhone & Android",
    devices: ["phone"],
    scApp: "pocket_casts",
    instructions: [
      "Open Pocket Casts.",
      "Tap Profile → Settings → Advanced → Add Podcast by URL.",
      "Paste the private feed URL below.",
    ],
    ctaLabel: "Copy feed URL",
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

function feedAppUrl(feed: UserFeed | null, scApp: string | undefined): string {
  if (!feed) return "";
  if (scApp) {
    const match = feed.apps?.find((a) => a.app === scApp);
    if (match) return match.url;
  }
  return feed.url;
}

export function SetupFlow({ me }: { me: Me }) {
  const { signOut } = useSubscriberAuth();
  const feed = me.feeds[0] ?? null;
  const feedUrl = feed?.url ?? "";

  const [device, setDevice] = useState<Device | null>(null);
  const [appKey, setAppKey] = useState<AppKey | null>(null);
  const [copied, setCopied] = useState(false);

  const [cancelState, setCancelState] = useState<
    "idle" | "confirming" | "cancelling" | "cancelled" | "error"
  >("idle");
  const [accessUntil, setAccessUntil] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleCancel = async () => {
    if (cancelState === "cancelling") return;
    setCancelState("cancelling");
    try {
      const result = await cancelSubscription();
      if (result.ok) {
        setCancelState("cancelled");
        setAccessUntil(result.access_until ?? null);
      } else {
        setCancelState("error");
        setCancelError(result.error ?? "Something went wrong.");
      }
    } catch {
      setCancelState("error");
      setCancelError("Could not reach the server. Please try again.");
    }
  };

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
    const scApps = new Set(feed?.apps?.map((a) => a.app) ?? []);
    // Hide any app whose scApp is missing from SC's response — it means that
    // integration isn't enabled on this plan, so our link would fall back to
    // the raw RSS URL, which most of those apps can't open. Apps with no
    // scApp (e.g. "manual", "downcast") are always shown.
    return APPS.filter((a) => {
      if (device && !a.devices.includes(device)) return false;
      if (a.scApp && !scApps.has(a.scApp)) return false;
      return true;
    });
  }, [device, feed]);

  const selectedApp = useMemo(
    () => APPS.find((a) => a.key === appKey) ?? null,
    [appKey],
  );

  const copyFeed = async () => {
    if (!feedUrl) return;
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      /* no-op */
    }
  };

  const selectedAppUrl = feedAppUrl(feed, selectedApp?.scApp);
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

  const [smsPhone, setSmsPhone] = useState("");
  const [smsState, setSmsState] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [smsError, setSmsError] = useState<string | null>(null);

  const handleSendSms = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smsPhone.trim() || smsState === "sending") return;
    setSmsState("sending");
    setSmsError(null);
    try {
      const result = await sendSetupSms(smsPhone, feed?.id);
      if (result.ok) {
        setSmsState("sent");
      } else {
        setSmsState("error");
        setSmsError(result.error ?? "Could not send SMS.");
      }
    } catch {
      setSmsState("error");
      setSmsError("Could not reach the server. Please try again.");
    }
  };

  const selfSmsHref = feedUrl
    ? `sms:?body=${encodeURIComponent(
        `Your Inside Call Me Back feed: ${feedUrl}`,
      )}`
    : "";

  return (
    <div className="ark-bg grain-overlay min-h-dvh text-fg-strong">
      {/* Dateline bar */}
      <div className="border-b border-rule-soft bg-navy-900">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-2 text-[11px] font-medium uppercase tracking-[0.22em] text-fg-muted sm:px-10">
          <span className="hidden sm:inline">Vol. I · No. 214</span>
          <span className="flex items-center gap-2">
            <span className="live-dot inline-block size-1.5 rounded-full bg-cyan" />
            Setup · Step {appKey ? "3" : device ? "2" : "1"} of 3
          </span>
          <span className="hidden text-cyan sm:inline">Subscriber Edition</span>
        </div>
      </div>

      {/* Header */}
      <header className="mx-auto flex max-w-[1280px] items-center justify-between px-6 pt-6 pb-4 sm:px-10 sm:pt-8">
        <Link to="/" className="flex items-center gap-3 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan">
          <ArkLogo height={60} />
          <span className="ml-2 hidden h-4 w-px bg-rule-strong sm:inline-block" />
          <span className="ml-2 hidden text-[11px] font-medium uppercase tracking-eyebrow text-cyan sm:inline">
            The Insider
          </span>
        </Link>
        <div className="flex min-w-0 items-center gap-6 text-[13px] text-fg">
          <span className="hidden min-w-0 max-w-[260px] truncate sm:inline-block">
            Signed in as{" "}
            <span className="text-fg-strong" title={me.email}>
              {me.email}
            </span>
          </span>
          <button
            type="button"
            onClick={signOut}
            className="shrink-0 underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1040px] px-6 pb-24 pt-6 sm:px-10 sm:pb-28">
        {/* Masthead row */}
        <div className="rise rise-1 flex flex-col items-start gap-6 sm:flex-row sm:items-end sm:gap-8">
          <div
            className="relative aspect-square w-[140px] shrink-0 overflow-hidden shadow-cover sm:w-[164px]"
            style={{ transform: "rotate(-1.5deg)" }}
          >
            <img
              src="/inside-cmb.jpg"
              alt="Inside Call Me Back"
              width={760}
              height={760}
              className="h-full w-full object-cover"
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 text-[12px] font-semibold uppercase tracking-[0.22em] text-cyan">
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
            <p className="mt-5 max-w-md text-[15px] leading-[1.6] text-fg">
              Get your exclusive Inside Call Me Back episodes in your podcast
              app of choice — in just a few steps.
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

        <div className="mt-12 hairline" />

        {/* Step 2 — App */}
        <Section
          number={2}
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
                  onClick={() => setAppKey(app.key)}
                />
              ))}
          </div>
          {visibleApps.some((a) => a.key === "manual") ? (
            <button
              type="button"
              onClick={() => setAppKey("manual")}
              className={`mt-3 w-full border px-4 py-3 text-left text-[13px] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:text-center ${
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
              <ol className="space-y-3 border border-rule bg-navy-800/60 p-6 text-[14px] leading-[1.65] text-fg sm:text-[15px]">
                {selectedApp.instructions.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="font-display text-[13px] font-bold text-cyan">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>

              <div className="flex flex-wrap items-center gap-4">
                {selectedApp.ctaLabel.startsWith("Copy") ? (
                  <button
                    type="button"
                    onClick={copyFeed}
                    className="group inline-flex items-center gap-3 bg-cyan px-6 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                  >
                    {copied ? "Copied ✓" : selectedApp.ctaLabel}
                    <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
                      →
                    </span>
                  </button>
                ) : (
                  <a
                    href={selectedAppUrl || feedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="group inline-flex items-center gap-3 bg-cyan px-6 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
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
                  className="text-[13px] text-fg-muted underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  {copied ? "Feed URL copied" : "Or copy the raw feed URL"}
                </button>
              </div>

              {device === "computer" && qrTarget && qrDataUrl ? (
                <QrHandoff
                  appName={selectedApp.name}
                  dataUrl={qrDataUrl}
                  target={qrTarget}
                />
              ) : null}

              {device === "phone" && feedUrl ? (
                <SmsHandoff
                  phone={smsPhone}
                  setPhone={setSmsPhone}
                  state={smsState}
                  error={smsError}
                  onSubmit={handleSendSms}
                  onReset={() => {
                    setSmsState("idle");
                    setSmsError(null);
                  }}
                  selfSmsHref={selfSmsHref}
                />
              ) : null}

              <div className="overflow-x-auto border border-rule bg-navy-900/60 p-4 font-mono text-[13px] whitespace-nowrap text-fg-muted sm:text-[12px]">
                {feedUrl || "No feed available for this membership yet."}
              </div>

              {selectedApp.note ? (
                <div className="border-l-2 border-signal/70 bg-signal/10 p-4 text-[13px] leading-[1.6] text-fg">
                  <span className="mr-1 font-semibold text-danger">Note —</span>
                  {selectedApp.note}
                </div>
              ) : null}
            </div>
          ) : null}
        </Section>

        {/* Cancel subscription */}
        <div className="mt-20 border-t border-rule-soft pt-10">
          {cancelState === "idle" ? (
            <button
              type="button"
              onClick={() => setCancelState("confirming")}
              className="text-[13px] text-fg-muted underline decoration-rule-strong underline-offset-[6px] transition hover:text-danger hover:decoration-danger/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
            >
              Cancel my subscription
            </button>
          ) : null}

          {cancelState === "confirming" ? (
            <div className="max-w-md space-y-4">
              <p className="text-[14px] leading-[1.6] text-fg">
                Are you sure you want to cancel? You'll keep access until the
                end of your current billing period.
              </p>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={handleCancel}
                  className="bg-danger px-5 py-2.5 font-display text-[12px] font-bold uppercase tracking-cta text-navy transition hover:bg-danger-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Yes, cancel
                </button>
                <button
                  type="button"
                  onClick={() => setCancelState("idle")}
                  className="text-[13px] text-fg-muted underline decoration-rule-strong underline-offset-[6px] transition hover:text-fg-strong hover:decoration-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
                >
                  Never mind
                </button>
              </div>
            </div>
          ) : null}

          {cancelState === "cancelling" ? (
            <p className="text-[14px] text-fg-muted">Cancelling...</p>
          ) : null}

          {cancelState === "cancelled" ? (
            <div className="max-w-md space-y-2">
              <p className="text-[14px] leading-[1.6] text-fg">
                Your subscription has been cancelled.
                {accessUntil ? (
                  <>
                    {" "}You'll have access until{" "}
                    <span className="text-fg-strong">
                      {new Date(accessUntil).toLocaleDateString(undefined, {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </span>
                    .
                  </>
                ) : null}
              </p>
            </div>
          ) : null}

          {cancelState === "error" ? (
            <div className="max-w-md space-y-3">
              <p className="text-[14px] text-danger">
                {cancelError}
              </p>
              <button
                type="button"
                onClick={() => setCancelState("idle")}
                className="text-[13px] text-fg-muted underline decoration-current underline-offset-[6px] transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
              >
                Try again
              </button>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function Section({
  number,
  title,
  subtitle,
  active,
  done,
  dimmed,
  hiddenOnMobile,
  children,
}: {
  number: number;
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
          className={`font-display text-[13px] font-bold uppercase tracking-[0.22em] ${
            done ? "text-cyan/70" : active ? "text-cyan" : "text-fg-faint"
          }`}
        >
          Step {number}
          {done ? " ✓" : ""}
        </span>
        <h2 className="text-fg-strong">
          <span className="display-upright text-[clamp(1.3rem,2.6vw,1.9rem)]">
            {title}
          </span>
        </h2>
      </div>
      <p className="mt-2 max-w-xl text-[13px] text-fg-muted">{subtitle}</p>
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
      <span className="font-display text-[15px] font-bold uppercase tracking-[0.08em] text-fg-strong">
        {label}
      </span>
      <span className="text-[12px] text-fg-muted">{hint}</span>
    </button>
  );
}

function AppCard({
  app,
  selected,
  onClick,
}: {
  app: AppDef;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-2 border p-4 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${
        selected
          ? "border-cyan bg-cyan/10"
          : "border-rule hover:border-cyan/60 hover:bg-fg-strong/[0.03]"
      }`}
    >
      <span className="font-display text-[14px] font-bold uppercase tracking-[0.06em] text-fg-strong">
        {app.name}
      </span>
      <span className="text-[11px] uppercase tracking-[0.18em] text-fg-muted">
        {app.tagline}
      </span>
    </button>
  );
}

function QrHandoff({
  appName,
  dataUrl,
  target,
}: {
  appName: string;
  dataUrl: string;
  target: string;
}) {
  return (
    <div className="flex flex-col gap-5 border border-rule bg-navy-900/40 p-6 sm:flex-row sm:items-center sm:gap-8">
      <div className="bg-white p-3 shrink-0">
        <img
          src={dataUrl}
          alt={`QR code to open ${appName} on your phone`}
          width={144}
          height={144}
          className="block size-36 sm:size-40"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
          <span className="h-px w-6 bg-cyan" />
          Continue on phone
        </div>
        <h3 className="mt-3 font-display text-[17px] font-bold uppercase tracking-[0.04em] text-fg-strong">
          Scan to open {appName}
        </h3>
        <p className="mt-2 text-[13px] leading-[1.6] text-fg-muted">
          Point your phone's camera at this code. It'll open the setup link on
          your phone so you can finish in the {appName} app.
        </p>
        <div className="mt-3 font-mono text-[11px] break-all text-fg-faint">
          {target}
        </div>
      </div>
    </div>
  );
}

function SmsHandoff({
  phone,
  setPhone,
  state,
  error,
  onSubmit,
  onReset,
  selfSmsHref,
}: {
  phone: string;
  setPhone: (v: string) => void;
  state: "idle" | "sending" | "sent" | "error";
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onReset: () => void;
  selfSmsHref: string;
}) {
  return (
    <div className="border border-rule bg-navy-900/40 p-6">
      <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan">
        <span className="h-px w-6 bg-cyan" />
        Text me the setup link
      </div>
      <p className="mt-2 text-[13px] leading-[1.6] text-fg-muted">
        We'll text you a link that opens your feed. Useful if you'd rather set
        this up on a different phone.
      </p>

      {state === "sent" ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-4 flex items-center justify-between gap-4 border border-cyan/40 bg-cyan/10 p-4"
        >
          <p className="text-[13px] leading-[1.6] text-fg-strong">
            Sent. Check your messages — tap the link to finish setup.
          </p>
          <button
            type="button"
            onClick={onReset}
            className="text-[12px] text-fg-muted underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            Send another
          </button>
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            aria-label="Phone number"
            placeholder="+1 555 123 4567"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="flex-1 border border-rule bg-navy-900/60 px-4 py-3 font-mono text-[14px] text-fg-strong placeholder:text-fg-placeholder focus:border-cyan focus:outline-none"
            disabled={state === "sending"}
          />
          <button
            type="submit"
            disabled={!phone.trim() || state === "sending"}
            aria-busy={state === "sending"}
            className="group inline-flex items-center justify-center gap-3 bg-cyan px-6 py-3 font-display text-[13px] font-bold uppercase tracking-[0.08em] text-navy transition hover:bg-fg-strong hover:text-navy-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
          >
            {state === "sending" ? "Sending..." : "Text me the link"}
            <span className="transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:translate-x-1 group-active:translate-x-1">
              →
            </span>
          </button>
        </form>
      )}

      {state === "error" && error ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      {selfSmsHref ? (
        <a
          href={selfSmsHref}
          className="mt-4 inline-block text-[12px] text-fg-muted underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          Or open Messages with the link pre-filled →
        </a>
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
