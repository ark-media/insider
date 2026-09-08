import { useState } from "react";
import {
  TERMS_STATEMENT,
  renewalStatement,
} from "../../shared/checkout-consent";

// The state behind the checkout consent boxes, and the call that makes the
// acceptance outlive the browser. Separate from the component it drives only
// because a file that exports both a component and a hook breaks fast refresh.
// See src/components/CheckoutConsent.tsx for what any of it is for.

/**
 * What the buyer is told they'll be charged, and how often. `amount` is null
 * when the renewal figure can't be read off the Session — the sentence is still
 * asked, without a number in it. See renewalDisclosure in CheckoutModal.
 */
export type Renewal = { amount: string | null; period: string };

/**
 * How long the consent write gets before the charge goes ahead without it.
 *
 * There has to be a bound. The call is awaited on the submit path, and a fetch
 * that never settles — captive portal, a dead connection the OS hasn't given up
 * on, our own endpoint stuck behind its rate limiter — never rejects, so
 * without this the buyer waits on "Processing…" forever, the double-submit
 * latch keeps their second click from doing anything, and confirm() is never
 * reached. Losing the sale to the bookkeeping call is precisely what the
 * comment below says must not happen.
 */
const RECORD_TIMEOUT_MS = 4000;

type ConsentValue = { terms: boolean; renewal: boolean };

const NO_CONSENT: ConsentValue = { terms: false, renewal: false };

function consentStatements(renewal: Renewal | null): string[] {
  return renewal === null
    ? [TERMS_STATEMENT]
    : [TERMS_STATEMENT, renewalStatement(renewal.amount, renewal.period)];
}

export type CheckoutConsentState = {
  value: ConsentValue;
  setValue: (next: ConsentValue) => void;
  /** Every required box is ticked — safe to charge. */
  complete: boolean;
  error: null | "missing" | "changed";
  /**
   * Call from the submit path. Returns false — and surfaces the prompt — when
   * something is still unticked, so a pay handler reads as
   * `if (!consent.confirm()) return`.
   */
  confirm: () => boolean;
  /** Stamp what was accepted onto the Checkout Session. See recordConsent. */
  record: (checkoutSessionId: string) => Promise<void>;
};

/**
 * Write the acceptance to the Stripe Checkout Session, where it sits next to
 * the charge it belongs to for as long as Stripe keeps the record. This is the
 * evidence half of the requirement — the checkboxes are only the collection.
 *
 * Deliberately not fatal, and deliberately bounded (RECORD_TIMEOUT_MS). A buyer
 * who has ticked both boxes has consented whether or not our metadata write
 * lands, and losing the sale to a failed — or merely slow — bookkeeping call
 * would be the worse outcome by a distance; the server logs what it couldn't
 * record. A timeout arrives here as an AbortError and takes the same path as
 * any other failure.
 */
async function recordConsent(
  checkoutSessionId: string,
  statements: string[],
): Promise<void> {
  try {
    const res = await fetch("/api/stripe/record-consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkout_session_id: checkoutSessionId,
        statements,
      }),
      signal: AbortSignal.timeout(RECORD_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[checkout] consent not recorded: status", res.status);
    }
  } catch (err) {
    console.error("[checkout] consent not recorded:", err);
  }
}

export function useCheckoutConsent(
  renewal: Renewal | null,
): CheckoutConsentState {
  const [value, setValue] = useState(NO_CONSENT);
  const [error, setError] = useState<null | "missing" | "changed">(null);

  // The renewal amount moves under the buyer: tax lands as soon as a usable
  // billing address is entered, and it's the total we disclose. A box ticked
  // against the old number is consent to a sentence we're no longer showing, so
  // the tick is withdrawn and re-asked — during render, because an effect would
  // leave one paint in which the stale acceptance was still enough to pay.
  const [disclosed, setDisclosed] = useState(renewal?.amount ?? null);
  const current = renewal?.amount ?? null;
  if (disclosed !== current) {
    setDisclosed(current);
    if (value.renewal) {
      setValue({ ...value, renewal: false });
      setError("changed");
    }
  }

  const complete = value.terms && (renewal === null || value.renewal);

  return {
    value,
    setValue,
    complete,
    error,
    confirm: () => {
      if (!complete) {
        setError("missing");
        return false;
      }
      setError(null);
      return true;
    },
    record: (checkoutSessionId) =>
      recordConsent(checkoutSessionId, consentStatements(renewal)),
  };
}
