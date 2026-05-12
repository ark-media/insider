import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

type CommonProps = {
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  cta?: string;
  badge?: ReactNode;
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
  "group relative block border border-rule bg-navy-800/40 p-6 transition hover:border-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function CardBody({ eyebrow, title, body, cta, badge }: CommonProps) {
  return (
    <>
      {badge ?? null}
      <div className="eyebrow">{eyebrow}</div>
      <div className="mt-4 line-clamp-3 font-display text-[22px] leading-[1.15] text-fg-strong">
        {title}
      </div>
      {body ? (
        <p className="mt-3 line-clamp-4 text-[13px] leading-[1.6] text-fg-muted">
          {body}
        </p>
      ) : null}
      {cta ? (
        <div className="mt-6 eyebrow text-fg-faint transition group-hover:text-cyan">
          {cta} →
        </div>
      ) : null}
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
    <article className="relative border border-rule bg-navy-800/40 p-6">
      <CardBody {...rest} />
      {children ? <div className="mt-6">{children}</div> : null}
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
}: {
  number: string;
  title: ReactNode;
  body: ReactNode;
  cta?: string;
  to?: string;
}) {
  const content = (
    <>
      <div className="display-upright shrink-0 text-[28px] text-cyan sm:text-[36px]">
        {number}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-3 font-display text-[20px] leading-[1.2] text-fg-strong sm:text-[24px]">
          {title}
        </div>
        <p className="mt-3 line-clamp-4 max-w-2xl text-[14px] leading-[1.6] text-fg-muted">
          {body}
        </p>
        {cta ? (
          <div className="mt-4 eyebrow text-fg-faint transition group-hover:text-cyan">
            {cta} →
          </div>
        ) : null}
      </div>
    </>
  );

  const containerClass =
    "group grid grid-cols-[auto_1fr] items-start gap-x-8 border-t border-rule py-8 transition first:border-t-0 first:pt-0 sm:gap-x-12";

  if (to) {
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
