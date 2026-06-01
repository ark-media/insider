import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ClampedText } from "./ClampedText";

type CommonProps = {
  eyebrow: string;
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

function CardText({ eyebrow, title, body, cta }: CommonProps) {
  return (
    <>
      <div className="eyebrow">{eyebrow}</div>
      <div className="mt-4 line-clamp-3 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </div>
      {body ? (
        <ClampedText
          text={body}
          className="mt-3 line-clamp-4 text-body-sm"
        />
      ) : null}
      {cta ? (
        <div className="mt-6 eyebrow text-fg-faint transition group-hover:text-cyan">
          {cta} →
        </div>
      ) : null}
    </>
  );
}

function CardBody({ badge, media, ...text }: CommonProps) {
  if (media) {
    // Split layout: the full (square) cover sits in the left half, inset with
    // padding and vertically centered; text and CTA fill the right half.
    return (
      <>
        {badge ?? null}
        <div className="flex items-stretch">
          <div className="flex w-1/2 shrink-0 items-center border-r border-rule p-6">
            <div className="w-full">{media}</div>
          </div>
          <div className="flex w-1/2 flex-col justify-center p-6">
            <CardText {...text} />
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
    "group grid grid-cols-[auto_1fr] items-start gap-x-5 border-t border-rule py-8 transition first:border-t-0 first:pt-4 sm:gap-x-12";

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
