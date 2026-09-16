import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ClampedText } from "./ClampedText";

type CommonProps = {
  title: ReactNode;
  body?: ReactNode;
  cta?: string;
  badge?: ReactNode;
  /** Optional square thumbnail shown beside the eyebrow + title. */
  media?: ReactNode;
};

type LinkCardProps = CommonProps & {
  to: string;
};

const cardClass =
  "group relative block overflow-hidden border border-rule bg-navy-800/40 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function CardText({
  title,
  body,
  cta,
  compact = false,
}: CommonProps & { compact?: boolean }) {
  return (
    <>
      <div
        className={`line-clamp-3 font-display leading-[1.15] text-fg-strong ${
          compact ? "text-[17px] sm:text-[22px]" : "text-[22px]"
        }`}
      >
        {title}
      </div>
      {body ? (
        <ClampedText
          text={body}
          className={`mt-3 line-clamp-4 text-body-sm ${
            // In a two-up phone grid the text column is ~130px — roughly 14
            // characters a line, which is unreadable. Art + title carry the
            // browse grid on phones; the copy returns once there's room for it.
            //
            // `sr-only` rather than `hidden`: the copy is only redundant to the
            // *eye* at this width, so hiding it visually is right but dropping
            // it from the accessibility tree is not — a screen-reader user on a
            // phone would just lose the description. Neither utility sets
            // `display`, which is what keeps `line-clamp`'s `-webkit-box`
            // intact; `hidden sm:block` would clobber it and unclamp the copy at
            // every width above the phone.
            compact ? "max-sm:sr-only" : ""
          }`}
        />
      ) : null}
      {cta ? (
        <div
          className={`eyebrow text-fg-faint transition group-hover:text-cyan ${
            // eyebrow's 14px + 0.22em tracking wraps the arrow onto its own line
            // in a two-up phone column — tightened until there's room for it.
            compact
              ? "mt-4 text-[11px] tracking-[0.1em] sm:mt-6 sm:text-xs sm:tracking-eyebrow"
              : "mt-6"
          }`}
        >
          {cta} →
        </div>
      ) : null}
    </>
  );
}

function CardBody({ badge, media, ...text }: CommonProps) {
  if (media) {
    // Cover stacks above the copy until there's width for a side-by-side split.
    // The 50/50 split needs ~500px of card to leave the text a readable column,
    // which only happens at `lg` — below that it stacks.
    return (
      <>
        {badge ?? null}
        <div className="flex flex-col lg:flex-row lg:items-stretch">
          <div className="border-b border-rule lg:flex lg:w-1/2 lg:shrink-0 lg:items-center lg:border-b-0 lg:border-r lg:p-6">
            <div className="w-full">{media}</div>
          </div>
          <div className="flex flex-col justify-start p-4 sm:p-6 lg:w-1/2">
            <CardText {...text} compact />
          </div>
        </div>
      </>
    );
  }
  return (
    <>
      {badge ?? null}
      <div className="p-6">
        <CardText {...text} />
      </div>
    </>
  );
}

export function LinkCard({ to, ...rest }: LinkCardProps) {
  return (
    <Link to={to} className={cardClass}>
      <CardBody {...rest} />
    </Link>
  );
}

