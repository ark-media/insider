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

type AnchorCardProps = CommonProps & {
  href: string;
  external?: boolean;
};

type StaticCardProps = CommonProps & {
  children?: ReactNode;
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

export function AnchorCard({ href, external, ...rest }: AnchorCardProps) {
  const externalAttrs = external
    ? { target: "_blank", rel: "noreferrer noopener" }
    : {};
  return (
    <a href={href} className={cardClass} {...externalAttrs}>
      <CardBody {...rest} />
    </a>
  );
}

export function StaticCard({ children, ...rest }: StaticCardProps) {
  return (
    <article className="relative overflow-hidden border border-rule bg-navy-800/40">
      <CardBody {...rest} />
      {children ? <div className="px-6 pb-6">{children}</div> : null}
    </article>
  );
}

/**
 * Editorial row variant — for hub pages where we want to break the card grid
 * monotony. Numbered eyebrow + headline + body in a horizontal layout.
 */
export function NumberedRow({
  number,
  title,
  body,
  cta,
  to,
  action,
}: {
  number: string;
  title: ReactNode;
  body: ReactNode;
  cta?: string;
  to?: string;
  /**
   * Optional interactive content (e.g. an inline form) rendered in place of the
   * `cta`. When present the row is never wrapped in a Link — a form can't live
   * inside an anchor — so pass this instead of `to`.
   */
  action?: ReactNode;
}) {
  const content = (
    <>
      <div className="display-upright shrink-0 text-[28px] text-cyan sm:text-[36px]">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-3 text-h3 sm:text-[24px]">
          {title}
        </div>
        <p className="mt-3 line-clamp-4 max-w-2xl text-body-sm">
          {body}
        </p>
        {action ? (
          <div className="mt-5 max-w-md">{action}</div>
        ) : cta ? (
          <div className="mt-4 eyebrow text-fg-faint transition group-hover:text-cyan">
            {cta} →
          </div>
        ) : null}
      </div>
    </>
  );

  const containerClass =
    "group grid grid-cols-[auto_1fr] items-start gap-x-5 border-t border-rule py-6 transition first:border-t-0 first:pt-3 sm:gap-x-8";

  if (to && !action) {
    return (
      <Link
        to={to}
        className={`${containerClass} hover:bg-navy-800/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan`}
      >
        {content}
      </Link>
    );
  }
  return <div className={containerClass}>{content}</div>;
}
