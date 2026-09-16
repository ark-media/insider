import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { useEffect, useRef, useState } from "react";
import {
  createCardSetupIntent,
  saveUpdatedCard,
  type CardOnFile,
} from "../../lib/auth";
import { cardLine } from "../../lib/card-on-file";
import { useTheme } from "../../lib/theme";

// The billing page's payment-method panel: the card the membership is billed
// to, and an in-page form to replace it.
//
// The form is Stripe's Payment Element on a SetupIntent, so the card number
// never touches our servers and 3-D Secure runs in Stripe's own modal. Saving
// is two steps with a gap between them: Stripe confirms the card, then
// /api/stripe/update-card bills the membership to it. If the second step fails
// the confirmed intent is kept, and the retry only repeats that step — Stripe
// refuses to confirm the same SetupIntent twice.

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as
  | string
  | undefined;

let stripePromise: Promise<StripeJs | null> | null = null;
function getStripe() {
  if (!publishableKey) return null;
  if (!stripePromise) stripePromise = loadStripe(publishableKey);
  return stripePromise;
}

const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 border border-cyan bg-cyan/10 px-5 py-3 button-text font-display font-bold text-cyan transition hover:bg-cyan/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 border border-rule-strong px-5 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:opacity-60";

type Mode =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "editing"; clientSecret: string }
  | { kind: "saved" };

export function PaymentMethodPanel({
  card,
  nextChargeLabel,
  onCardChanged,
}: {
  // The card the membership bills to now, or null when there isn't one we can
  // describe (a non-card method, or an unreadable one).
  card: CardOnFile | null;
  // The long-form date of the next charge, or null when there won't be one
  // (the membership is set to end) or we don't know it.
  nextChargeLabel: string | null;
  onCardChanged: (card: CardOnFile | null) => void;
}) {
  const { theme } = useTheme();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const stripe = getStripe();

  // Saving unmounts the form the member was focused in, so focus moves to the
  // confirmation instead of being stranded on <body>.
  const confirmationRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (mode.kind === "saved") confirmationRef.current?.focus();
  }, [mode.kind]);

  const onOpen = async () => {
    if (!stripe) {
      setError("Card updates aren't available right now. Please contact us and we'll sort it out.");
      return;
    }
    setError(null);
    setMode({ kind: "opening" });
    const result = await createCardSetupIntent();
    if (result.ok) {
      setMode({ kind: "editing", clientSecret: result.clientSecret });
    } else {
      setMode({ kind: "idle" });
      setError(result.error);
    }
  };

  return (
    <div className="max-w-xl border border-rule bg-navy-800/40 p-8">
      <h2 className="label text-cyan">Payment method</h2>

      {mode.kind === "editing" && stripe ? (
        <Elements
          stripe={stripe}
          options={{
            clientSecret: mode.clientSecret,
            appearance: {
              theme: theme === "light" ? "stripe" : "night",
              labels: "floating",
            },
          }}
        >
          <p className="mt-4 max-w-md text-body-sm text-fg">
            {card
              ? `Your new card replaces the one ending ${card.last4}`
              : "Your new card becomes the one your membership is billed to"}
            {nextChargeLabel
              ? `, starting with your next charge on ${nextChargeLabel}.`
              : "."}
          </p>
          <CardForm
            cancelLabel={card ? "Keep current card" : "Never mind"}
            onCancel={() => {
              setMode({ kind: "idle" });
              setError(null);
            }}
            onSaved={(next) => {
              onCardChanged(next);
              setMode({ kind: "saved" });
            }}
          />
        </Elements>
      ) : (
        <>
          {card ? (
            <p className="mt-4 text-body-sm text-fg-strong">{cardLine(card)}</p>
          ) : null}
          <p className={`${card ? "mt-1" : "mt-4"} max-w-md text-body-sm text-fg-muted`}>
            {!card
              ? "Update the card your membership is billed to."
              : nextChargeLabel
                ? `Your next charge, on ${nextChargeLabel}, goes to this card.`
                : "This is the card on file for your membership."}
          </p>

          {mode.kind === "saved" ? (
            <p
              ref={confirmationRef}
              tabIndex={-1}
              className="mt-6 text-body-sm text-cyan focus:outline-none"
              aria-live="polite"
            >
              Card updated.
            </p>
          ) : null}

          <button
            type="button"
            onClick={onOpen}
            disabled={mode.kind === "opening"}
            className={`mt-6 ${secondaryButtonClass}`}
          >
            {mode.kind === "opening" ? "Opening…" : "Update card"}
          </button>
          {error ? (
            <p className="mt-3 text-body-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function CardForm({
  cancelLabel,
  onCancel,
  onSaved,
}: {
  cancelLabel: string;
  onCancel: () => void;
  onSaved: (card: CardOnFile | null) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set once Stripe has confirmed the card, so a retry after a failed save
  // skips straight to billing the membership to it.
  const confirmedIntentId = useRef<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || saving) return;
    setSaving(true);
    setError(null);

    if (!confirmedIntentId.current) {
      // Cards only, so nothing here redirects: 3-D Secure opens in Stripe's
      // modal and the promise settles on this page.
      const { error: confirmError, setupIntent } = await stripe.confirmSetup({
        elements,
        redirect: "if_required",
      });
      if (confirmError) {
        // Card and validation errors are Stripe's own sentences about the
        // card itself ("Your card was declined."), written to be shown.
        // Anything else is about the integration, not the member.
        setError(
          (confirmError.type === "card_error" ||
            confirmError.type === "validation_error") &&
            confirmError.message
            ? confirmError.message
            : "Could not save that card — please try again.",
        );
        setSaving(false);
        return;
      }
      if (setupIntent?.status !== "succeeded") {
        setError("Your bank hasn't confirmed that card yet — please try again.");
        setSaving(false);
        return;
      }
      confirmedIntentId.current = setupIntent.id;
    }

    const result = await saveUpdatedCard(confirmedIntentId.current);
    if (!result.ok) {
      setError(result.error);
      setSaving(false);
      return;
    }
    onSaved(result.card);
  };

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <PaymentElement onReady={() => setReady(true)} />
      {!ready ? (
        <p className="text-body-sm text-fg-muted" aria-live="polite">
          Loading the card form…
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 text-body-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          type="submit"
          disabled={!stripe || !elements || !ready || saving}
          className={primaryButtonClass}
        >
          {saving ? "Saving…" : "Save card"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={secondaryButtonClass}
        >
          {cancelLabel}
        </button>
      </div>
    </form>
  );
}
