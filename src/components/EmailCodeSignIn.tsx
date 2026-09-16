import { useSubscriberAuth } from "../lib/subscriberAuth";

/**
 * Secondary sign-in affordance: sends the member straight to Auth0's
 * passwordless prompt, which emails them a one-time code instead of asking for
 * a password.
 *
 * Why this is a control we own rather than a button on Auth0's page: with both
 * a database connection and the passwordless one enabled, New Universal Login
 * renders *no* passwordless option beside the password box — Auth0's position
 * is that a passwordless connection signs people up on sight, so offering it
 * there could silently create a duplicate account. The only way in is for us to
 * pass `connection=email` to /authorize, so if this link doesn't exist, the
 * feature is unreachable. See auth0/README.md.
 *
 * Deliberately a text link, not a second button. Sign-in surfaces here keep a
 * single primary action (see PublicMasthead) — this is the escape hatch
 * underneath it, for the two cases that otherwise dead-end: a member who never
 * set a password (everyone is provisioned without one and picks it from a reset
 * email they may never open), and one whose Google address isn't the address
 * they subscribed with.
 *
 * `returnTo` matches the sibling Sign in button's, so both doors land in the
 * same place. `loginHint` prefills the address when we already know it.
 */
export function EmailCodeSignIn({
  returnTo,
  loginHint,
  className = "",
}: {
  returnTo?: string;
  loginHint?: string;
  className?: string;
}) {
  const { signIn } = useSubscriberAuth();
  return (
    <button
      type="button"
      onClick={() => signIn(returnTo, { connection: "email", loginHint })}
      className={`inline-flex min-h-11 items-center text-body-sm text-fg-muted underline decoration-current underline-offset-[6px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan ${className}`}
    >
      Email me a code instead
    </button>
  );
}
