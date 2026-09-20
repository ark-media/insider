import type { NewsletterSlug } from "../data/newsletters";
import { circleUrls, newsletterCircleSpaces } from "../config/urls";

/**
 * Circle links.
 *
 * The website reads nothing out of the Fold — it is a private community, and
 * every public page is marketing. What belongs here is the set of links that
 * send a member TO Circle, plus the store-link picker that decides which app
 * store to offer a given visitor.
 */

/** Universal app-open link — used by /account "Open in app" buttons. */
export const CIRCLE_OPEN_LINKS = {
  ios: circleUrls.appStoreIos,
  android: circleUrls.appStoreAndroid,
  web: circleUrls.webApp,
};

/**
 * Build the comment URL for a newsletter post — the post's Circle space.
 * Circle owns auth (SSO against our Auth0 tenant), so a signed-in member lands
 * on the discussion and a signed-out one is bounced through Auth0 first.
 */
export function newsletterCommentUrl(slug: NewsletterSlug): string {
  return newsletterCircleSpaces[slug];
}

/**
 * The store links worth putting in front of *this* visitor.
 *
 * A phone gets the one store it can actually install from — offering an iPhone
 * a Google Play badge is noise. Anything else gets both, since a desktop
 * browser tells us nothing about which phone they'll reach for. iPadOS 13+
 * reports itself as "Macintosh", so touch points are what separate an iPad
 * from a Mac.
 */
export function circleAppDownloads(): {
  platform: "ios" | "android";
  label: string;
  href: string;
}[] {
  const ios = {
    platform: "ios" as const,
    label: "iOS",
    href: circleUrls.appStoreIos,
  };
  const android = {
    platform: "android" as const,
    label: "Android",
    href: circleUrls.appStoreAndroid,
  };
  if (typeof navigator === "undefined") return [ios, android];
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return [ios];
  if (ua.includes("Macintosh") && navigator.maxTouchPoints > 1) return [ios];
  if (/Android/i.test(ua)) return [android];
  return [ios, android];
}
