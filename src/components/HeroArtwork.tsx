import { srcSet } from "../lib/images";
import { hosts, type HostSlug } from "../data/hosts";
import { getShow } from "../data/shows";

/**
 * The artwork that fills the square card in the /plus hero. Three directions
 * while one is being picked; the winner stays and the rest go.
 *
 * Everything here is built from the real roster in `data/hosts.ts`, so adding a
 * host adds them to the artwork. The source headshots are inconsistent (square
 * / 4:5 / landscape, grey vs white vs blue vs street backdrops, one already
 * black-and-white), which is why each portrait carries its own focal point and
 * why two of the three compositions either grade the photos to the brand
 * palette or hide the backgrounds behind a die-cut edge.
 */

export type ArtVariant = "plus" | "nowplaying" | "stickers" | "marquee" | "dial";

/**
 * `object-position` per portrait — hand-set, because the framing varies enough
 * that a blanket "50% 50%" crops half the roster off at the chin.
 */
const FOCUS: Partial<Record<HostSlug, string>> = {
  "dan-senor": "50% 26%",
  "donniel-hartman": "50% 26%",
  "yossi-klein-halevi": "50% 30%",
  "nadav-eyal": "56% 30%",
  "amit-segal": "50% 20%",
  "yonatan-adiri": "50% 26%",
  "yael-wissner-levy": "50% 28%",
  "deborah-pardes": "46% 32%",
};

type Member = { slug: HostSlug; name: string; photo: string; focus: string };

function member(slug: HostSlug): Member {
  const host = hosts.find((h) => h.slug === slug);
  // Every slug used below is in the roster with a headshot; the guard only
  // exists so a future roster edit fails loudly instead of rendering a broken
  // <img>.
  if (!host?.headshot) throw new Error(`HeroArtwork: no headshot for ${slug}`);
  return { slug, name: host.name, photo: host.headshot, focus: FOCUS[slug] ?? "50% 28%" };
}

const DAN = member("dan-senor");
const ROSTER: Member[] = [
  member("donniel-hartman"),
  member("yossi-klein-halevi"),
  member("nadav-eyal"),
  member("amit-segal"),
  member("deborah-pardes"),
  member("yonatan-adiri"),
  member("yael-wissner-levy"),
];

/**
 * `duotone` floors the shadows to brand navy and ceilings the highlights to
 * brand cyan, which collapses eight different studio backdrops into the same
 * two brand colours — worth it when the photos butt up against each other.
 * `natural` keeps them in colour, for compositions where a die-cut edge already
 * hides the background and the colour is doing the work.
 */
type Grade = "duotone" | "natural";

function Portrait({
  who,
  grade = "duotone",
  sizes,
  className = "",
  style,
}: {
  who: Member;
  grade?: Grade;
  /** The rendered slot width — these are all small, so state it honestly. */
  sizes: string;
  /**
   * Must include a `position` (`relative` or `absolute`). Deliberately not
   * defaulted: a base `relative` here would beat a caller's `absolute` in
   * Tailwind's cascade order and silently drop the layout back into flow.
   */
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    // `isolate` keeps the blend layers blending with the photo underneath them
    // rather than with whatever the composition painted behind it.
    <span className={`isolate block overflow-hidden ${className}`} style={style}>
      <img
        src={who.photo}
        srcSet={srcSet(who.photo)}
        sizes={sizes}
        alt=""
        loading="lazy"
        decoding="async"
        className={
          grade === "duotone"
            ? "h-full w-full object-cover [filter:grayscale(1)_contrast(1.2)_brightness(1.02)]"
            : "h-full w-full object-cover [filter:saturate(1.08)_contrast(1.06)]"
        }
        style={{ objectPosition: who.focus }}
      />
      {grade === "duotone" ? (
        <>
          <span aria-hidden="true" className="absolute inset-0 bg-navy mix-blend-lighten" />
          <span aria-hidden="true" className="absolute inset-0 bg-cyan opacity-55 mix-blend-darken" />
        </>
      ) : null}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Option 1 — The Plus
 * The brand mark is the composition. A dense collage of the whole roster,
 * punched out in the shape of the Ark+ plus, with Dan filling the crossing.
 * Faces that meet the edge get sliced by it, which is the point — it reads as a
 * cut-out, not as a grid of avatars.
 * ------------------------------------------------------------------------ */

/** Arms 44% wide, 28% deep. Same polygon on both layers gives a cyan keyline. */
const PLUS_CLIP =
  "polygon(28% 0%, 72% 0%, 72% 28%, 100% 28%, 100% 72%, 72% 72%, 72% 100%, 28% 100%, 28% 72%, 0% 72%, 0% 28%, 28% 28%)";

/**
 * The arms tiled edge to edge, as % of the frame — no gaps, so the plus reads
 * as one solid shape made of faces rather than portraits floating in a plus.
 * Top and bottom arms take two tiles each, the left arm two, the right arm one
 * full-height tile: seven, which is the roster minus Dan.
 */
const PLUS_SLOTS = [
  { l: 28, t: 0, w: 22, h: 28 },
  { l: 50, t: 0, w: 22, h: 28 },
  { l: 0, t: 28, w: 28, h: 22 },
  { l: 0, t: 50, w: 28, h: 22 },
  { l: 72, t: 28, w: 28, h: 44 },
  { l: 28, t: 72, w: 22, h: 28 },
  { l: 50, t: 72, w: 22, h: 28 },
];

function ThePlus() {
  return (
    <div className="relative aspect-square">
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          background:
            "radial-gradient(circle closest-side at 50% 50%, rgb(62 181 249 / 0.45) 0%, transparent 75%)",
        }}
      />

      {/* Cyan plate, then the collage inset inside the same shape — the sliver
          of plate left showing around the edge is the keyline. */}
      <div className="absolute inset-[3%] bg-cyan" style={{ clipPath: PLUS_CLIP }}>
        <div
          className="absolute inset-[3px] overflow-hidden bg-navy-900"
          style={{ clipPath: PLUS_CLIP }}
        >
          {ROSTER.map((who, i) => (
            <Portrait
              key={who.slug}
              who={who}
              sizes="90px"
              className="absolute"
              style={{
                left: `${PLUS_SLOTS[i].l}%`,
                top: `${PLUS_SLOTS[i].t}%`,
                width: `${PLUS_SLOTS[i].w}%`,
                height: `${PLUS_SLOTS[i].h}%`,
              }}
            />
          ))}
          {/* Dan fills the crossing */}
          <Portrait
            who={DAN}
            sizes="170px"
            className="absolute top-[28%] left-[28%] h-[44%] w-[44%]"
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Option 2 — The Membership
 * The card is the product, and Ark+ is two things, so the card is two panels:
 * the private feed mid-playback on top, the community underneath. Sells what is
 * being bought rather than illustrating it, and the live level meter on the
 * playing row is what catches the eye.
 *
 * Show titles come from `data/shows.ts` and the community rows name real
 * features. There are deliberately no episode titles, member counts or post
 * text here — episode data is fetched from Simplecast at runtime and must never
 * be hardcoded, and the rest would be invented numbers on a marketing page.
 * ------------------------------------------------------------------------ */

const FEED: { show: Parameters<typeof getShow>[0]; people: Member[] }[] = [
  { show: "call-me-back", people: [DAN, member("nadav-eyal")] },
  { show: "for-heavens-sake", people: [member("donniel-hartman"), member("yossi-klein-halevi")] },
];

/** The other half of the membership. Between them the two panels show all eight. */
const COMMUNITY: { title: string; tag: string; people: Member[] }[] = [
  {
    title: "Live member Q&A",
    tag: "Live",
    people: [member("yonatan-adiri"), member("yael-wissner-levy"), member("amit-segal")],
  },
  { title: "Dan's Book Club", tag: "→", people: [DAN, member("deborah-pardes")] },
];

/** Bar heights for the level meter, in %. Fixed so the meter is deterministic. */
const LEVELS = [40, 72, 55, 90, 62, 100, 48, 78, 35, 66, 52, 84];

function Meter({ live }: { live: boolean }) {
  return (
    <div aria-hidden="true" className="flex h-5 items-center gap-[3px]">
      {LEVELS.map((h, i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full bg-cyan ${live ? "level-bar" : "opacity-30"}`}
          style={{
            height: `${h}%`,
            // Staggered so the meter travels instead of pulsing as one block.
            animationDelay: live ? `${(i % 6) * 0.11}s` : undefined,
          }}
        />
      ))}
    </div>
  );
}

function Stack({ people }: { people: Member[] }) {
  return (
    <div className="flex shrink-0 -space-x-2">
      {people.map((who) => (
        <Portrait
          key={who.slug}
          who={who}
          grade="natural"
          sizes="36px"
          className="relative aspect-square w-9 rounded-full ring-2 ring-navy-900"
        />
      ))}
    </div>
  );
}

function NowPlaying() {
  return (
    <div className="relative flex aspect-square flex-col px-4 py-4">
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 75% 40% at 50% 12%, rgb(62 181 249 / 0.35) 0%, transparent 70%)",
        }}
      />

      <div className="relative flex flex-1 flex-col justify-center gap-4">
        {/* Panel one — the private feed */}
        <div>
          <div className="flex items-center gap-2">
            <span className="live-dot inline-block h-2 w-2 rounded-full bg-cyan" />
            <span className="eyebrow text-cyan">Private feed</span>
            <span className="ml-auto bg-cyan px-2 py-0.5 label tracking-[0.16em] text-navy">
              Ad-free
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {FEED.map((row, i) => {
              const show = getShow(row.show);
              const live = i === 0;
              return (
                <div
                  key={row.show}
                  className={`flex items-center gap-3 px-3 py-2 ${
                    live ? "bg-cyan/12 ring-1 ring-cyan/40" : "ring-1 ring-rule"
                  }`}
                >
                  <Stack people={row.people} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body-sm text-fg-strong">{show?.shortTitle}</div>
                    <div className="mt-1">
                      <Meter live={live} />
                    </div>
                  </div>
                  <span
                    aria-hidden="true"
                    className={`shrink-0 text-[13px] ${live ? "text-cyan" : "text-fg-faint"}`}
                  >
                    {live ? "▮▮" : "▶"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Panel two — the community */}
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-block h-2 w-2 rounded-full bg-cyan/50" />
            <span className="eyebrow text-cyan">The community</span>
            <span className="ml-auto label tracking-[0.16em] text-fg-muted ring-1 ring-rule-strong px-2 py-0.5">
              Members only
            </span>
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {COMMUNITY.map((row) => (
              <div key={row.title} className="flex items-center gap-3 px-3 py-2 ring-1 ring-rule">
                <Stack people={row.people} />
                <div className="min-w-0 flex-1 truncate text-body-sm text-fg-strong">
                  {row.title}
                </div>
                <span
                  aria-hidden="true"
                  className={`shrink-0 ${
                    row.tag === "Live"
                      ? "label tracking-[0.16em] text-cyan ring-1 ring-cyan/40 px-2 py-0.5"
                      : "text-[13px] text-fg-faint"
                  }`}
                >
                  {row.tag}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Option 3 — Sticker Sheet
 * The roster as die-cut stickers, scattered and overlapping, mixed in with a
 * few graphic ones. Photos stay in full colour here: the thick paper edge is
 * already hiding the mismatched backgrounds, so the colour is free to do the
 * work of making it feel fun.
 * ------------------------------------------------------------------------ */

/**
 * Face stickers, given as centre / size / rotation in % of the frame. Centres
 * sit on a ring around Dan rather than being scattered freehand: that keeps all
 * four corners of the square clear, which is where the word stickers go. Sizes
 * and tilts still vary, so it doesn't read as an even ring of avatars.
 */
const STICKERS = [
  { cx: 50, cy: 11, s: 25, r: -9 },
  { cx: 79, cy: 24, s: 23, r: 8 },
  { cx: 86, cy: 55, s: 25, r: -6 },
  { cx: 64, cy: 81, s: 24, r: 11 },
  { cx: 34, cy: 80, s: 26, r: -12 },
  { cx: 14, cy: 55, s: 23, r: 6 },
  { cx: 21, cy: 24, s: 24, r: -5 },
];

/** A sticker's paper edge — fixed paper white in both themes, like real vinyl. */
const DIE_CUT = "border-[5px] border-[var(--color-paper)] shadow-float";

function Stickers() {
  return (
    <div className="relative aspect-square overflow-hidden">
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 55% at 50% 45%, rgb(62 181 249 / 0.4) 0%, transparent 72%)",
        }}
      />

      {/* Word stickers go down FIRST, in the corners the face ring leaves free,
          so that where they do meet a face they slide under it — a banner
          across someone's chin is the one thing that would kill this. */}
      <div
        className={`absolute top-[3%] left-[2%] bg-navy px-3 py-2 ${DIE_CUT}`}
        style={{ transform: "rotate(-7deg)" }}
      >
        <div className="label tracking-[0.2em] text-white">Every show</div>
      </div>
      <div
        className={`absolute top-[2%] right-[2%] bg-navy px-3 py-2 ${DIE_CUT}`}
        style={{ transform: "rotate(8deg)" }}
      >
        <div className="label tracking-[0.2em] text-white">Ad-free</div>
      </div>
      {/* The bottom-right gap in the face ring. Small enough to fit it without
          a word sticker having to run under someone's chin. */}
      <div
        aria-hidden="true"
        className={`absolute right-[3%] bottom-[4%] flex aspect-square w-[17%] items-center justify-center rounded-full bg-cyan ${DIE_CUT}`}
        style={{ transform: "rotate(-12deg)" }}
      >
        <span className="display-upright text-[26px] leading-none text-navy">+</span>
      </div>

      {ROSTER.map((who, i) => {
        const p = STICKERS[i];
        return (
          <Portrait
            key={who.slug}
            who={who}
            grade="natural"
            sizes="110px"
            className={`absolute aspect-square rounded-full ${DIE_CUT}`}
            style={{
              left: `${p.cx - p.s / 2}%`,
              top: `${p.cy - p.s / 2}%`,
              width: `${p.s}%`,
              transform: `rotate(${p.r}deg)`,
            }}
          />
        );
      })}

      {/* Dan, biggest and squarest, on top of everything */}
      <Portrait
        who={DAN}
        grade="natural"
        sizes="170px"
        className={`absolute top-[29%] left-[29%] aspect-square w-[42%] rounded-[30%] ${DIE_CUT}`}
        style={{ transform: "rotate(-3deg)" }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Option 4 — Marquee
 * Three ticker rows of the roster running in opposite directions at different
 * speeds. The motion is the whole hook: nothing else on the page moves, so the
 * eye goes here. Rows fade out at both edges so the loop has no visible seam.
 * ------------------------------------------------------------------------ */

const EVERYONE: Member[] = [DAN, ...ROSTER];

/** Fades the row out at both ends, so items enter and leave instead of popping. */
const EDGE_FADE =
  "linear-gradient(90deg, transparent 0%, #000 12%, #000 88%, transparent 100%)";

function Ticker({
  people,
  seconds,
  reverse = false,
}: {
  people: Member[];
  seconds: number;
  reverse?: boolean;
}) {
  // Two identical copies: the track travels exactly one copy's width (-50%),
  // so the second copy lands where the first began and the loop is seamless.
  const loop = [...people, ...people];
  return (
    <div
      className="relative overflow-hidden"
      style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
    >
      <div
        className={`marquee-track flex w-max items-center gap-3 ${reverse ? "marquee-rev" : ""}`}
        style={{ animationDuration: `${seconds}s` }}
      >
        {loop.map((who, i) => (
          <div key={`${who.slug}-${i}`} className="flex shrink-0 items-center gap-2">
            <Portrait
              who={who}
              grade="natural"
              sizes="40px"
              className="relative aspect-square w-10 shrink-0 rounded-full ring-1 ring-cyan/40"
            />
            <span className="display-upright text-[14px] whitespace-nowrap text-fg-strong">
              {who.name}
            </span>
            <span aria-hidden="true" className="display text-[14px] text-cyan">
              +
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Six rows, each starting at a different point in the roster and running at its
 * own speed — so no two rows ever line up the same face at the same x, which is
 * what would give away that it's one list repeated.
 */
const ROWS = [
  { offset: 0, seconds: 32, reverse: false },
  { offset: 3, seconds: 41, reverse: true },
  { offset: 6, seconds: 36, reverse: false },
  { offset: 1, seconds: 46, reverse: true },
  { offset: 5, seconds: 34, reverse: false },
  { offset: 2, seconds: 39, reverse: true },
];

function Marquee() {
  return (
    <div className="relative flex aspect-square flex-col justify-between overflow-hidden py-5">
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 55% at 50% 50%, rgb(62 181 249 / 0.38) 0%, transparent 72%)",
        }}
      />
      {ROWS.map((row) => (
        <div key={row.offset} className="relative">
          <Ticker
            people={[...EVERYONE.slice(row.offset), ...EVERYONE.slice(0, row.offset)]}
            seconds={row.seconds}
            reverse={row.reverse}
          />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Option 5 — Radio Dial
 * The card is a tuner. A band of portraits slides past a cyan playhead with the
 * tuned host sharp and full size at the centre and the neighbours shrinking and
 * dimming away toward the edges, over a dial scale carrying the whole roster as
 * stations.
 * ------------------------------------------------------------------------ */

/** centre-x / width / opacity, as % of the frame. Symmetrical around Dan. */
const TUNER = [
  { cx: 0, w: 17, o: 0.3 },
  { cx: 22, w: 24, o: 0.6 },
  { cx: 50, w: 36, o: 1 },
  { cx: 78, w: 24, o: 0.6 },
  { cx: 100, w: 17, o: 0.3 },
];

/**
 * Where each host sits on the dial, in % across the scale. Deliberately uneven
 * — evenly spaced stations look like a chart axis, not a radio dial. Dan sits
 * at 50, under the playhead.
 */
const STATIONS = [6, 15, 27, 38, 50, 61, 73, 88];

function Dial() {
  // The band shows five: Dan tuned in at the centre, two either side sliding
  // off. Everyone appears on the scale below regardless.
  const band = [ROSTER[5], ROSTER[0], DAN, ROSTER[1], ROSTER[6]];
  const onDial = [ROSTER[2], ROSTER[3], ROSTER[5], ROSTER[0], DAN, ROSTER[1], ROSTER[6], ROSTER[4]];
  return (
    <div className="relative aspect-square overflow-hidden">
      <div
        aria-hidden="true"
        className="drift absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 45% 60% at 50% 45%, rgb(62 181 249 / 0.45) 0%, transparent 72%)",
        }}
      />

      <div className="absolute inset-x-0 top-5 text-center eyebrow text-cyan">Tuned in</div>

      {/* Playhead first, so the portraits sit on top of it. A needle drawn over
          the tuned host's face is the one thing that would spoil this. */}
      <div aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan/70" />

      {/* The band of stations sliding past the playhead */}
      {band.map((who, i) => {
        const t = TUNER[i];
        const tuned = i === 2;
        return (
          <Portrait
            key={`${who.slug}-${i}`}
            who={who}
            grade={tuned ? "natural" : "duotone"}
            sizes={tuned ? "140px" : "90px"}
            className={`absolute top-[42%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full ${
              tuned ? "ring-2 ring-cyan shadow-cover" : "ring-1 ring-cyan/30"
            }`}
            style={{ left: `${t.cx}%`, width: `${t.w}%`, opacity: t.o }}
          />
        );
      })}

      <div
        aria-hidden="true"
        className="absolute top-[66%] left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-cyan"
      />

      {/* The dial scale */}
      <div className="absolute inset-x-6 bottom-[11%]">
        <div className="relative h-8">
          {STATIONS.map((x, i) => (
            <Portrait
              key={onDial[i].slug}
              who={onDial[i]}
              grade="duotone"
              sizes="30px"
              className={`absolute top-0 aspect-square w-7 -translate-x-1/2 rounded-full ${
                x === 50 ? "ring-2 ring-cyan" : "opacity-55 ring-1 ring-cyan/30"
              }`}
              style={{ left: `${x}%` }}
            />
          ))}
        </div>
        <div className="relative mt-3 h-4">
          <div className="absolute inset-x-0 top-0 h-px bg-rule-strong" />
          {/* Ticks: a tall one where a host sits, short ones in between. */}
          {Array.from({ length: 41 }, (_, i) => i * 2.5).map((x) => {
            const isStation = STATIONS.some((s) => Math.abs(s - x) < 1.3);
            return (
              <span
                key={x}
                aria-hidden="true"
                className={`absolute top-0 w-px -translate-x-1/2 ${isStation ? "h-3 bg-cyan" : "h-1.5 bg-rule-strong"}`}
                style={{ left: `${x}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

const COMPOSITIONS: Record<ArtVariant, () => React.ReactElement> = {
  plus: ThePlus,
  nowplaying: NowPlaying,
  stickers: Stickers,
  marquee: Marquee,
  dial: Dial,
};

export function HeroArtwork({ variant }: { variant: ArtVariant }) {
  const Composition = COMPOSITIONS[variant];
  return (
    <div
      role="img"
      aria-label="The Ark Media hosts"
      className="relative border border-rule-strong bg-navy-900/60 shadow-cover"
      style={{ transform: "rotate(-1.5deg)" }}
    >
      <Composition />
    </div>
  );
}
