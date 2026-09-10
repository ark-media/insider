import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/**
 * The house audio player.
 *
 * Beehiiv has no embeddable player — it returns a direct `audio_url` — so the
 * show and episode pages drive playback themselves. Everything runs off one
 * `<audio>` element we own, which
 * means the controls inherit the site's own tokens instead of an iframe's
 * chrome, and the page keeps working with the browser's media keys.
 *
 * The layout follows the Megaphone-style podcast bar: cover art at the left, a
 * large round play button, and a waveform whose ends carry the elapsed and
 * total time. The waveform is decoration over a real `<input type="range">`,
 * and the buttons are real buttons, so keyboard and screen-reader support is
 * the platform's rather than ours.
 */

const SKIP_SECONDS = 15;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75] as const;

/**
 * The keys that move an `<input type="range">`. A scrub must start on these and
 * nothing else: `keydown` for a key that doesn't change the value (Tab above
 * all, which moves focus before `keyup` fires) would open a scrub that never
 * closes.
 */
const SEEK_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

function isSeekKey(key: string): boolean {
  return SEEK_KEYS.has(key);
}

/** mm:ss, widening to h:mm:ss only once an hour is on the clock. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const BAR_COUNT = 140;

/**
 * Bar heights for the waveform, in 0..1.
 *
 * We never decode the audio — that would mean downloading the whole episode
 * before the player could paint — so the shape is generated from the source
 * URL instead. Same episode, same waveform, every visit; different episodes
 * look different from each other, which is the only thing the shape has to do.
 */
function waveformFor(src: string): number[] {
  let seed = 2166136261;
  for (let i = 0; i < src.length; i++) {
    seed ^= src.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  // mulberry32 — small, deterministic, and good enough for decoration.
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const phase = rand() * Math.PI * 2;
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    // A slow swell across the clip plus per-bar noise: speech-shaped rather
    // than a flat comb, and never so short that a bar disappears.
    const swell =
      0.66 + 0.34 * Math.sin((i / BAR_COUNT) * Math.PI * 3.4 + phase);
    // A second, faster octave gives the bursts a real waveform has between the
    // steady stretches of speech.
    const detail = 0.34 + 0.66 * rand() * (0.55 + 0.45 * rand());
    bars.push(Math.min(1, Math.max(0.14, swell * detail * 1.35)));
  }
  return bars;
}

export function AudioPlayer({
  src,
  title,
  /** Cover art — the episode's own image, else the show cover. */
  artworkUrl,
  /**
   * Duration in minutes from the episode record. Shown as the total until the
   * browser has metadata, so the control doesn't flash "0:00" on first paint.
   */
  fallbackDurationMinutes,
  className = "",
}: {
  src: string;
  title: string;
  artworkUrl?: string | null;
  fallbackDurationMinutes?: number;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  // While the user drags, the thumb follows the pointer rather than the
  // element's timeupdate events — otherwise the two fight and the thumb snaps back.
  const [scrubbing, setScrubbing] = useState(false);
  // The same flag as a ref, because `onChange` fires in the same event batch as
  // the `pointerdown`/`keydown` that starts a scrub: the state value is still
  // the old one there, the ref is already current.
  const scrubbingRef = useRef(false);
  // Where the user has dragged to but not yet let go. The media element is only
  // told once, on release — assigning `currentTime` on every `input` event
  // aborts the in-flight media fetch and issues a fresh byte-range request, so
  // a single drag across a 40MB episode can stall playback for its duration.
  const pendingSeekRef = useRef<number | null>(null);

  const speed = SPEEDS[speedIndex]!;
  const effectiveDuration =
    duration || Math.max(0, (fallbackDurationMinutes ?? 0) * 60);

  // A new episode means a new source, so the old one's position and duration
  // are meaningless. Reset during render rather than in an effect: React's
  // "adjusting state when a prop changes" pattern, which re-renders before
  // anything paints instead of flashing the previous episode's progress.
  const [renderedSrc, setRenderedSrc] = useState(src);
  if (renderedSrc !== src) {
    setRenderedSrc(src);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setScrubbing(false);
  }

  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = speed;
  }, [speed, src]);

  // A drag in flight when the episode changes must not commit its position to
  // the new track. Refs can't be cleared in the render-time reset above, so
  // they're cleared here.
  useEffect(() => {
    scrubbingRef.current = false;
    pendingSeekRef.current = null;
  }, [src]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      // play() rejects when the browser blocks autoplay or the file 404s.
      // Swallow it: the element's own `pause` event keeps our state honest.
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }, []);

  const skip = useCallback(
    (delta: number) => {
      const el = audioRef.current;
      if (!el) return;
      // `el.duration` is NaN before `loadedmetadata`, and `fallbackDurationMinutes`
      // is optional — so the upper bound can legitimately be unknown here.
      // Clamping to it anyway would send `currentTime` to 0, turning the
      // forward-15 button into a rewind-to-start. Only clamp when we have a
      // real length; otherwise let the element clamp itself at the true end.
      const max = el.duration || effectiveDuration;
      const raw = Math.max(0, el.currentTime + delta);
      const next = max > 0 ? Math.min(raw, max) : raw;
      el.currentTime = next;
      setCurrentTime(next);
    },
    [effectiveDuration],
  );

  // Starts a scrub. Only called for interactions that actually move the thumb —
  // see `isSeekKey` for why the keyboard case is filtered.
  const beginScrub = useCallback(() => {
    scrubbingRef.current = true;
    setScrubbing(true);
  }, []);

  // Ends a scrub and commits the dragged-to position. Idempotent: several of
  // the handlers wired to it can fire for one gesture, and `pointercancel` /
  // `blur` are there precisely because the matching `pointerup` / `keyup`
  // sometimes never arrives.
  const endScrub = useCallback(() => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    const to = pendingSeekRef.current;
    pendingSeekRef.current = null;
    const el = audioRef.current;
    if (el && to !== null) el.currentTime = to;
  }, []);

  // The thumb always tracks the input; the media element only follows when the
  // gesture ends (pointerup / keyup / blur), which is what keeps one drag to
  // one seek. The fallback branch covers a value change that arrives without a
  // scrub having been opened — a browser that synthesises `input` on its own.
  const onScrubChange = useCallback((to: number) => {
    setCurrentTime(to);
    if (scrubbingRef.current) {
      pendingSeekRef.current = to;
      return;
    }
    const el = audioRef.current;
    if (el) el.currentTime = to;
  }, []);

  const bars = useMemo(() => waveformFor(src), [src]);
  const seekable = effectiveDuration > 0;
  const pct = seekable
    ? Math.min(100, (currentTime / effectiveDuration) * 100)
    : 0;

  const elapsed = formatTime(currentTime);
  const total = formatTime(effectiveDuration);

  return (
    <div className={`border border-rule bg-navy-800/40 p-4 sm:p-5 ${className}`}>
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onDurationChange={(e) => setDuration(e.currentTarget.duration || 0)}
        onTimeUpdate={(e) => {
          if (!scrubbing) setCurrentTime(e.currentTarget.currentTime);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
      >
        <track kind="captions" />
      </audio>

      <div className="flex items-center gap-4 sm:gap-5">
        {artworkUrl ? (
          <img
            src={artworkUrl}
            alt=""
            loading="lazy"
            className="size-16 shrink-0 border-2 border-cyan object-cover sm:size-28"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 sm:gap-4">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={playing ? `Pause ${title}` : `Play ${title}`}
              className="grid size-12 shrink-0 place-items-center rounded-full bg-cyan text-navy transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan sm:size-14"
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>

            <div className="min-w-0 flex-1">
              <div className="relative h-11 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-4 has-[:focus-visible]:outline-cyan sm:h-16">
                <Waveform bars={bars} pct={pct} />

                {/* The chips ride the ends of the waveform the way the reference
                    player does. Below sm there isn't room, so the same two
                    readings drop to a row underneath instead. */}
                <TimeChip className="left-1.5 hidden bg-cyan text-navy sm:block">
                  {elapsed}
                </TimeChip>
                <TimeChip className="right-1.5 hidden bg-navy-600 text-fg-strong sm:block">
                  {total}
                </TimeChip>

                {seekable ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-cyan"
                    style={{ left: `${pct}%` }}
                  />
                ) : null}

                <input
                  type="range"
                  className="audio-scrub"
                  min={0}
                  max={effectiveDuration || 0}
                  step={1}
                  value={Math.min(currentTime, effectiveDuration || 0)}
                  disabled={!seekable}
                  aria-label={`Seek within ${title}`}
                  aria-valuetext={`${elapsed} of ${total}`}
                  onPointerDown={beginScrub}
                  onPointerUp={endScrub}
                  // A touch gesture that turns into a page scroll ends in
                  // `pointercancel`, not `pointerup`.
                  onPointerCancel={endScrub}
                  onKeyDown={(e) => {
                    if (isSeekKey(e.key)) beginScrub();
                  }}
                  onKeyUp={endScrub}
                  // Last resort. Tab moves focus on keydown, so the matching
                  // keyup lands on the next element and never reaches this
                  // handler — without this the scrub would never end and the
                  // progress bar would sit frozen for the rest of the episode.
                  onBlur={endScrub}
                  onChange={(e) => onScrubChange(Number(e.currentTarget.value))}
                />
              </div>

              <div className="mt-1 flex items-center justify-between text-xs tabular-nums text-fg-muted sm:hidden">
                <span>{elapsed}</span>
                <span>{total}</span>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-3 sm:mt-4">
            <ControlButton
              onClick={() => setSpeedIndex((i) => (i + 1) % SPEEDS.length)}
              label={`Playback speed: ${speed}×. Change speed`}
              className="border border-rule-strong px-2 py-1 text-xs tabular-nums"
            >
              {speed}×
            </ControlButton>
            <ControlButton
              onClick={() => skip(-SKIP_SECONDS)}
              label={`Rewind ${SKIP_SECONDS} seconds`}
            >
              <SkipIcon seconds={SKIP_SECONDS} direction="back" />
            </ControlButton>
            <ControlButton
              onClick={() => skip(SKIP_SECONDS)}
              label={`Forward ${SKIP_SECONDS} seconds`}
            >
              <SkipIcon seconds={SKIP_SECONDS} direction="forward" />
            </ControlButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The bars, drawn twice: once dim for the whole clip, once in cyan clipped to
 * the played fraction. `preserveAspectRatio="none"` lets one fixed viewBox
 * stretch to whatever width the column ends up with.
 */
function Waveform({ bars, pct }: { bars: number[]; pct: number }) {
  const clipId = useId();
  const width = bars.length * 3;
  const rects = bars.map((h, i) => (
    <rect
      // Bars are positional decoration — index is the identity.
      key={i}
      x={i * 3}
      y={50 - h * 50}
      width={2}
      height={h * 100}
    />
  ));

  return (
    <svg
      viewBox={`0 0 ${width} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="h-full w-full"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={(width * pct) / 100} height={100} />
        </clipPath>
      </defs>
      <g className="text-rule-strong" fill="currentColor">
        {rects}
      </g>
      <g className="text-cyan" fill="currentColor" clipPath={`url(#${clipId})`}>
        {rects}
      </g>
    </svg>
  );
}

function TimeChip({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`pointer-events-none absolute top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs font-bold tabular-nums ${className}`}
    >
      {children}
    </span>
  );
}

function ControlButton({
  onClick,
  label,
  className = "",
  children,
}: {
  onClick: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`inline-flex items-center justify-center text-fg-muted transition hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${className}`}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 2.3v11.4a.6.6 0 0 0 .92.51l9-5.7a.6.6 0 0 0 0-1.02l-9-5.7a.6.6 0 0 0-.92.51Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="1" />
    </svg>
  );
}

/** A looping arrow with the skip length set inside it, as on the reference bar. */
function SkipIcon({
  seconds,
  direction,
}: {
  seconds: number;
  direction: "back" | "forward";
}) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g transform={direction === "forward" ? "translate(16 0) scale(-1 1)" : ""}>
        <path d="M8 2.6a5.4 5.4 0 1 1-5.4 5.4" />
        <path d="M5.5 0.5 3 2.6l2.5 2.1" />
      </g>
      <text
        x="8"
        y="10.6"
        textAnchor="middle"
        fontSize="6.4"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        {seconds}
      </text>
    </svg>
  );
}
