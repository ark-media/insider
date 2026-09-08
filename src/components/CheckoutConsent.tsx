import { type ReactNode } from "react";
import type { CheckoutConsentState, Renewal } from "../lib/checkoutConsent";

/**
 * The two consent checkboxes that sit directly above a checkout's pay button,
 * and the state machine behind them.
 *
 * They replaced Stripe's own consent_collection + TermsElement, which recorded
 * the acceptance for us but could only ever be one box saying one thing (and
 * only for accounts in the Terms Element beta, on top of a Dashboard terms URL).
 * Counsel wants the auto-renewal named separately and ticked separately, so the
 * boxes are ours — and with them the obligation to record the acceptance, which
 * POST /api/stripe/record-consent does before the charge.
 *
 * `renewal` is null for a one-time purchase (a gift), which has nothing to
 * renew: the second box is not rendered and not required. It is an explicit
 * prop rather than something inferred from the Checkout Session, so a
 * subscription can never quietly lose its renewal disclosure because Stripe
 * returned a null `recurring`.
 */

export function CheckoutConsent({
  renewal,
  consent,
}: {
  renewal: Renewal | null;
  consent: CheckoutConsentState;
}) {
  const { value, setValue, error } = consent;
  // The withdrawn-tick prompt only stands while that box is actually empty;
  // once it's back, anything still missing gets the ordinary prompt.
  const message =
    error === "changed" && !value.renewal
      ? "The renewal amount changed — please confirm it again."
      : error !== null && !consent.complete
        ? renewal
          ? "Please tick the boxes above to continue."
          : "Please tick the box above to continue."
        : null;
  return (
    <fieldset className="space-y-3 border-t border-rule pt-4">
      <legend className="sr-only">Before you pay</legend>
      <ConsentCheckbox
        checked={value.terms}
        invalid={error === "missing" && !value.terms}
        onChange={(terms) => setValue({ ...value, terms })}
      >
        I agree to the <LegalLink to="/terms">Terms of Service</LegalLink> and
        acknowledge the <LegalLink to="/privacy">Privacy Policy</LegalLink>.
      </ConsentCheckbox>
      {renewal ? (
        <ConsentCheckbox
          checked={value.renewal}
          invalid={error !== null && !value.renewal}
          onChange={(next) => setValue({ ...value, renewal: next })}
        >
          I understand my subscription renews automatically at {renewal.amount}{" "}
          {renewal.period} until I cancel.
        </ConsentCheckbox>
      ) : null}
      {message ? (
        <p role="alert" className="text-body-sm text-danger">
          {message}
        </p>
      ) : null}
    </fieldset>
  );
}

function ConsentCheckbox({
  checked,
  invalid,
  onChange,
  children,
}: {
  checked: boolean;
  invalid: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 text-body-sm ${
        invalid ? "text-danger" : "text-fg-muted"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * Links open in a new tab on purpose: a router <Link> would unmount the modal
 * mid-purchase and throw away the Stripe Checkout Session behind it — and here
 * it would also throw away the ticks the buyer had already made.
 */
function LegalLink({ to, children }: { to: string; children: string }) {
  return (
    <a
      href={to}
      target="_blank"
      rel="noopener noreferrer"
      // A label doesn't forward activation to its control from an interactive
      // descendant, so opening the policy can't tick the box. Belt and braces,
      // because an accidental tick is the one failure this component can't have.
      onClick={(e) => e.stopPropagation()}
      className="underline decoration-current underline-offset-[3px] transition hover:text-cyan hover:decoration-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
    >
      {children}
    </a>
  );
}
