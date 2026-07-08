import type { ReactNode } from "react";
import {
  LISTEN_PLATFORM_LABEL,
  type ListenLink,
  type ListenPlatform,
} from "../data/shows";
import { ApplePodcastsIcon, SpotifyIcon, YouTubeIcon } from "./PlatformIcons";
import { trackEvent } from "../lib/analytics";

// Full-color brand marks for the "listen on" row. See PlatformIcons for why
// these are inline multi-color SVGs. Platforms without a mark here render the
// label alone.
const PLATFORM_ICON: Partial<Record<ListenPlatform, ReactNode>> = {
  spotify: <SpotifyIcon />,
  apple: <ApplePodcastsIcon />,
  youtube: <YouTubeIcon />,
};

// The "listen on" row shared by show heroes and episode pages. Each platform
// shows its brand mark next to the label. When `interactive` is false the
// chips render as static labels (no link) — used on the soft-launch pitch
// where non-members can't yet reach the private feed.
export function ListenLinks({
  listen,
  className = "",
  interactive = true,
}: {
  listen: ListenLink[];
  className?: string;
  interactive?: boolean;
}) {
  if (listen.length === 0) return null;

  const chipClass =
    "inline-flex items-center gap-2 border border-rule-strong px-3 py-1.5 button-text font-semibold text-fg";

  return (
    <div
      className={`flex flex-wrap items-center gap-3 text-body-sm ${className}`}
    >
      {listen.map((l) =>
        interactive ? (
          <a
            key={l.platform}
            href={l.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={() => trackEvent("listen_link_clicked", { platform: l.platform })}
            className={`${chipClass} transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan`}
          >
            {PLATFORM_ICON[l.platform] ?? null}
            {LISTEN_PLATFORM_LABEL[l.platform]}
          </a>
        ) : (
          <span key={l.platform} className={`${chipClass} text-fg-muted`}>
            {PLATFORM_ICON[l.platform] ?? null}
            {LISTEN_PLATFORM_LABEL[l.platform]}
          </span>
        ),
      )}
    </div>
  );
}
