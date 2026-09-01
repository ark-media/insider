import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The house audio player.
 *
 * Beehiiv has no embeddable player — it returns a direct `audio_url` — so this
 * replaces the `player.simplecast.com` iframe that used to sit on the show and
 * episode pages. Everything is driven off one `<audio>` element we own, which
 * means the controls inherit the site's own tokens instead of an iframe's
 * chrome, and the page keeps working with the browser's media keys.
 *
 * The visible controls are real buttons and a real `<input type="range">`, so
 * keyboard and screen-reader support is the platform's rather than ours.
 */

const SKIP_SECONDS = 15;
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.75] as const;

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

export function AudioPlayer({
  src,
  title,
  /**
   * Duration in minutes from the episode record. Shown as the total until the
   * browser has metadata, so the control doesn't flash "0:00" on first paint.
   */
  fallbackDurationMinutes,
  className = "",
}: {
  src: string;
  title: string;
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
      const max = el.duration || effectiveDuration;
      const next = Math.min(Math.max(0, el.currentTime + delta), max || 0);
      el.currentTime = next;
      setCurrentTime(next);
    },
    [effectiveDuration],
  );

  const seek = useCallback((to: number) => {
    const el = audioRef.current;
    if (el) el.currentTime = to;
    setCurrentTime(to);
  }, []);

  const pct =
    effectiveDuration > 0
      ? Math.min(100, (currentTime / effectiveDuration) * 100)
      : 0;

  return (
    <div
      className={`border border-rule bg-navy-800/40 p-4 sm:p-5 ${className}`}
    >
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

      <div className="flex items-center gap-3 sm:gap-4">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? `Pause ${title}` : `Play ${title}`}
          className="grid size-12 shrink-0 place-items-center rounded-full bg-cyan text-navy-900 transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div className="min-w-0 flex-1">
          <input
            type="range"
            className="audio-scrub"
            style={{ "--pct": `${pct}%` } as React.CSSProperties}
            min={0}
            max={effectiveDuration || 0}
            step={1}
            value={Math.min(currentTime, effectiveDuration || 0)}
            disabled={effectiveDuration <= 0}
            aria-label={`Seek within ${title}`}
            aria-valuetext={`${formatTime(currentTime)} of ${formatTime(effectiveDuration)}`}
            onPointerDown={() => setScrubbing(true)}
            onPointerUp={() => setScrubbing(false)}
            onKeyDown={() => setScrubbing(true)}
            onKeyUp={() => setScrubbing(false)}
            onChange={(e) => seek(Number(e.currentTarget.value))}
          />
          <div className="mt-1 flex items-center justify-between text-[0.8125rem] tabular-nums text-fg-muted">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(effectiveDuration)}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <ControlButton
          onClick={() => skip(-SKIP_SECONDS)}
          label={`Rewind ${SKIP_SECONDS} seconds`}
        >
          <RewindIcon />
          {SKIP_SECONDS}
        </ControlButton>
        <ControlButton
          onClick={() => skip(SKIP_SECONDS)}
          label={`Forward ${SKIP_SECONDS} seconds`}
        >
          {SKIP_SECONDS}
          <ForwardIcon />
        </ControlButton>
        <ControlButton
          className="ml-auto"
          onClick={() => setSpeedIndex((i) => (i + 1) % SPEEDS.length)}
          label={`Playback speed: ${speed}×. Change speed`}
        >
          {speed}×
        </ControlButton>
      </div>
    </div>
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
      className={`inline-flex items-center gap-1 border border-rule px-2.5 py-1.5 text-[0.8125rem] tabular-nums text-fg-muted transition hover:border-rule-strong hover:text-fg-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${className}`}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4.5 2.3v11.4a.6.6 0 0 0 .92.51l9-5.7a.6.6 0 0 0 0-1.02l-9-5.7a.6.6 0 0 0-.92.51Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="1" />
    </svg>
  );
}

function RewindIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3.2a4.8 4.8 0 1 1-4.8 4.8" />
      <path d="M5.6 1.2 3.2 3.2l2.4 2" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3.2a4.8 4.8 0 1 0 4.8 4.8" />
      <path d="M10.4 1.2l2.4 2-2.4 2" />
    </svg>
  );
}
