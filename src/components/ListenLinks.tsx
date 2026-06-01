import type { ReactNode } from "react";
import {
  LISTEN_PLATFORM_LABEL,
  type ListenLink,
  type ListenPlatform,
} from "../data/shows";

// Full-color brand marks for the "listen on" row. These are inline SVGs (rather
// than the currentColor-masked glyphs the footer uses) because each logo is
// multi-color — Spotify's green disc, YouTube's red tile, Apple's purple mic —
// and a single-color mask can't reproduce that. Platforms without a mark here
// (overcast, pocket-casts) render the label alone.
const PLATFORM_ICON: Partial<Record<ListenPlatform, ReactNode>> = {
  spotify: <SpotifyIcon />,
  apple: <ApplePodcastsIcon />,
  youtube: <YouTubeIcon />,
};

// The "listen on" row shared by show heroes and episode pages. Each platform
// shows its brand mark next to the label.
export function ListenLinks({
  listen,
  className = "",
}: {
  listen: ListenLink[];
  className?: string;
}) {
  if (listen.length === 0) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 text-body-sm ${className}`}
    >
      {listen.map((l) => (
        <a
          key={l.platform}
          href={l.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-2 border border-rule-strong px-3 py-1.5 button-text font-semibold text-fg transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {PLATFORM_ICON[l.platform] ?? null}
          {LISTEN_PLATFORM_LABEL[l.platform]}
        </a>
      ))}
    </div>
  );
}

function SpotifyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" fill="#1ED760" />
      <path
        fill="#000"
        d="M17.9 10.9c-3.2-1.9-8.5-2.1-11.6-1.2a.92.92 0 1 1-.53-1.76c3.55-1.08 9.45-.86 13.13 1.32a.92.92 0 1 1-.94 1.58Zm-.11 2.84a.77.77 0 0 1-1.06.25c-2.65-1.63-6.69-2.1-9.83-1.15a.77.77 0 1 1-.45-1.47c3.59-1.09 8.04-.56 11.08 1.31a.77.77 0 0 1 .26 1.06Zm-1.21 2.73a.61.61 0 0 1-.84.2c-2.32-1.42-5.24-1.74-8.67-.95a.61.61 0 1 1-.27-1.2c3.76-.86 6.99-.49 9.59 1.1a.61.61 0 0 1 .19.85Z"
      />
    </svg>
  );
}

function ApplePodcastsIcon() {
  // The simple-icons glyph draws the microphone and antenna rings as cutouts in
  // a filled rounded square. A white layer sits behind, and the purple-gradient
  // square on top, so the cutouts read as a white mic — the official mark.
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="apple-podcasts-grad" x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F452FF" />
          <stop offset="1" stopColor="#822CBE" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5.34" fill="#fff" />
      <path
        fill="url(#apple-podcasts-grad)"
        d="M5.34 0A5.328 5.328 0 000 5.34v13.32A5.328 5.328 0 005.34 24h13.32A5.328 5.328 0 0024 18.66V5.34A5.328 5.328 0 0018.66 0zm6.525 2.568c2.336 0 4.448.902 6.056 2.587 1.224 1.272 1.912 2.619 2.264 4.392.12.59.12 2.2.007 2.864a8.506 8.506 0 01-3.24 5.296c-.608.46-2.096 1.261-2.336 1.261-.088 0-.096-.091-.056-.46.072-.592.144-.715.48-.856.536-.224 1.448-.874 2.008-1.435a7.644 7.644 0 002.008-3.536c.208-.824.184-2.656-.048-3.504-.728-2.696-2.928-4.792-5.624-5.352-.784-.16-2.208-.16-3 0-2.728.56-4.984 2.76-5.672 5.528-.184.752-.184 2.584 0 3.336.456 1.832 1.64 3.512 3.192 4.512.304.2.672.408.824.472.336.144.408.264.472.856.04.36.03.464-.056.464-.056 0-.464-.176-.896-.384l-.04-.03c-2.472-1.216-4.056-3.274-4.632-6.012-.144-.706-.168-2.392-.03-3.04.36-1.74 1.048-3.1 2.192-4.304 1.648-1.737 3.768-2.656 6.128-2.656zm.134 2.81c.409.004.803.04 1.106.106 2.784.62 4.76 3.408 4.376 6.174-.152 1.114-.536 2.03-1.216 2.88-.336.43-1.152 1.15-1.296 1.15-.023 0-.048-.272-.048-.603v-.605l.416-.496c1.568-1.878 1.456-4.502-.256-6.224-.664-.67-1.432-1.064-2.424-1.246-.64-.118-.776-.118-1.448-.008-1.02.167-1.81.562-2.512 1.256-1.72 1.704-1.832 4.342-.264 6.222l.413.496v.608c0 .336-.027.608-.06.608-.03 0-.264-.16-.512-.36l-.034-.011c-.832-.664-1.568-1.842-1.872-2.997-.184-.698-.184-2.024.008-2.72.504-1.878 1.888-3.335 3.808-4.019.41-.145 1.133-.22 1.814-.211zm-.13 2.99c.31 0 .62.06.844.178.488.253.888.745 1.04 1.259.464 1.578-1.208 2.96-2.72 2.254h-.015c-.712-.331-1.096-.956-1.104-1.77 0-.733.408-1.371 1.112-1.745.224-.117.534-.176.844-.176zm-.011 4.728c.988-.004 1.706.349 1.97.97.198.464.124 1.932-.218 4.302-.232 1.656-.36 2.074-.68 2.356-.44.39-1.064.498-1.656.288h-.003c-.716-.257-.87-.605-1.164-2.644-.341-2.37-.416-3.838-.218-4.302.262-.616.974-.966 1.97-.97z"
      />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      <path
        fill="#FF0000"
        d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.51A3.02 3.02 0 0 0 .5 6.2 31.5 31.5 0 0 0 0 12a31.5 31.5 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14c1.88.51 9.38.51 9.38.51s7.5 0 9.38-.51a3.02 3.02 0 0 0 2.12-2.14A31.5 31.5 0 0 0 24 12a31.5 31.5 0 0 0-.5-5.8Z"
      />
      <path fill="#fff" d="M9.6 15.6V8.4l6.27 3.6L9.6 15.6Z" />
    </svg>
  );
}
