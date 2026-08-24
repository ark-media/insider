/**
 * Terms + Privacy disclosure, rendered directly above a checkout's primary
 * button. Links open in a new tab on purpose: a router <Link> would unmount the
 * modal mid-purchase and throw away the Stripe Checkout Session behind it.
 *
 * scope "privacy" drops the terms half, for the payment steps where Stripe's
 * own consent checkbox (see CheckoutTerms) already carries that link.
 */
export function CheckoutLegal({
  action,
  scope = "both",
}: {
  action: string;
  scope?: "both" | "privacy";
}) {
  return (
    <p className="text-body-sm text-fg-muted">
      By {action} you agree to our{" "}
      {scope === "both" ? (
        <>
          <LegalLink to="/terms">Terms of Service</LegalLink> and{" "}
        </>
      ) : null}
      <LegalLink to="/privacy">Privacy Policy</LegalLink>.
    </p>
  );
}

function LegalLink({ to, children }: { to: string; children: string }) {
  return (
    <a
      href={to}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-current underline-offset-[3px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      {children}
    </a>
  );
}
