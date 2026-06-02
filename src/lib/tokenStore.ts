// Session presence hints. The real sessions live in httpOnly cookies the
// server sets (`ark_session` for the Auth0 login, `ark_checkout` for the
// post-checkout auto-login) — JS can't read those. Each has a non-httpOnly
// companion cookie set purely as a "a session probably exists" signal, so the
// SPA knows whether to bother calling /api/me before rendering as a guest.

function hasCookie(name: string): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${name}=`));
}

export function hasCheckoutCookie(): boolean {
  return hasCookie("ark_checkout_present");
}

export function hasSessionCookie(): boolean {
  return hasCookie("ark_session_present");
}

export function hasAnySession(): boolean {
  return hasSessionCookie() || hasCheckoutCookie();
}
