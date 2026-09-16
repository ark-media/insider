import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { trackEvent } from "../lib/analytics";

/**
 * The single chokepoint for every link that sends a visitor off our domain.
 *
 * We are a media business whose product is partly *elsewhere* — Circle, the app
 * stores, Spotify/Apple, five social profiles, Beehiiv. Before this existed
 * none of that outflow was measured: five social icons with no onClick, every
 * Fold card a bare `<a>`. Wrapping them all in one component means the
 * `outbound_link_clicked` event can never drift the way seven hand-written
 * `trackEvent` calls would (BI plan §4.1, §2.2).
 *
 * Behavior notes:
 *   - Only the destination HOST is reported. Private-feed and Circle deep links
 *     carry per-member tokens in their path and query; sending the full URL to
 *     PostHog would leak them.
 *   - Links back to our own host render normally but fire nothing — "outbound"
 *     has to mean outbound for the number to be worth anything. This matters for
 *     the newsletter and show-notes renderers, which pass through whatever hrefs
 *     the source content contains.
 *   - `rel="noreferrer noopener"` and `target="_blank"` are the defaults, since
 *     that is what every call site was already doing; either can be overridden.
 *   - Any `onClick` passed in still runs, after the event. Call sites that have
 *     their own richer event (FeedSetupHub's `feed_spotify_linked`) keep it.
 */
export function OutboundLink({
  href,
  platform,
  placement,
  context,
  onClick,
  children,
  target = "_blank",
  rel = "noreferrer noopener",
  ...rest
}: {
  href: string;
  /** The brand being handed off to — 'instagram', 'circle', 'ios', 'spotify'. */
  platform: string;
  /** Where on our site the link sat — 'footer', 'community_feed', 'setup_hub'. */
  placement: string;
  /** Optional discriminator within a placement: a space slug, an event id. */
  context?: string;
  children: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const destination = destinationHost(href);
    if (destination) {
      trackEvent("outbound_link_clicked", {
        destination,
        platform,
        placement,
        ...(context ? { context } : {}),
      });
    }
    onClick?.(event);
  };

  return (
    <a href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}

/**
 * The bare host of an outbound href, or null when the link isn't outbound —
 * a relative href, an unparseable one, or one pointing back at us. Null also
 * covers server-side rendering (the renderer tests run without a DOM), where
 * there is no current host to compare against and nothing to track anyway.
 */
function destinationHost(href: string): string | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = stripWww(url.hostname.toLowerCase());
  const self = stripWww(window.location.hostname.toLowerCase());
  // Our own apex and any subdomain of it are internal navigation, not outflow.
  if (host === self || host.endsWith(`.${self}`) || self.endsWith(`.${host}`)) {
    return null;
  }
  return host;
}

function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}
