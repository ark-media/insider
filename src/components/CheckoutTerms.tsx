import { Component, useState, type ReactNode } from "react";
import { TermsElement } from "@stripe/react-stripe-js/checkout";
import { CheckoutLegal } from "./CheckoutLegal";

/**
 * Stripe's Terms of Service consent checkbox, plus the privacy disclosure it
 * doesn't cover. Both Checkout Sessions are created with
 * consent_collection.terms_of_service = 'required', so Stripe refuses to
 * confirm until this is ticked, and records the acceptance on the Session
 * (consent.terms_of_service = 'accepted') — the evidence a passive "by
 * subscribing you agree" line never produced.
 *
 * TermsElement is beta-gated: Stripe enables it per account. Without access,
 * creating the element throws inside Stripe's own effect, which would take the
 * whole payment form down with it — hence the boundary. The fallback restores
 * the plain disclosure, so a buyer sees a normal form; they still can't pay
 * (Stripe blocks confirm on an unaccepted required consent) and Stripe's error
 * surfaces on the pay button. That state means the beta isn't on: drop
 * consent_collection from both Sessions until it is.
 */
export function CheckoutTerms({ action }: { action: string }) {
  const [loadFailed, setLoadFailed] = useState(false);
  const fallback = <CheckoutLegal action={action} />;

  return loadFailed ? (
    fallback
  ) : (
    <TermsBoundary fallback={fallback}>
      <TermsElement
        onLoadError={(event) => {
          console.error("[checkout] Stripe TermsElement failed:", event.error);
          setLoadFailed(true);
        }}
      />
      {/* The checkbox links your Dashboard terms URL and nothing else, so the
          privacy half of the disclosure still has to be said here. */}
      <CheckoutLegal action={action} scope="privacy" />
    </TermsBoundary>
  );
}

class TermsBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[checkout] Stripe TermsElement failed to mount:", error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
