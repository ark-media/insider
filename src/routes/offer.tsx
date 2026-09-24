import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  getWelcomeOffer,
  redeemWelcomeOffer,
  type WelcomeOffer,
} from "../lib/auth";
import { formatMinor } from "../lib/currency";
import { fmtDate } from "../lib/entitlement-axes";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { AGE_STATEMENT } from "../../shared/checkout-consent";
import { WELCOME_OFFER_CLOSES_LABEL } from "../../shared/welcome-offer";

// Where an existing Ark+ subscriber lands from the welcome-offer email (mailed
// 2026-10-05, open until 2026-10-31).
//
// The link carries nothing about the offer: the server decides eligibility from
// who is signed in and what their own subscription is. The link signs its
// holder in as the member it was sent to, and for its first 48 hours that
// session can also redeem (server/lib/guards.ts) — so a forwarded email is
// the member's own offer, taken on their own card.
export const Route = createFileRoute("/offer")({
  component: OfferPage,
});

const primaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50";
const secondaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 border border-rule-strong px-6 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

type View =
  | { kind: "loading" }
  | { kind: "offer"; offer: WelcomeOffer }
  | { kind: "ineligible"; reason: string }
  | { kind: "done"; plan: "monthly" | "yearly"; renewsAt: string | null }
  | { kind: "error" };

// Why the offer isn't available, in the member's terms. Each one names what to
// do next, because "you're not eligible" with no next step is the message that
// generates the support email.
function ineligibleCopy(reason: string): { title: string; body: string } {
  switch (reason) {
    case "expired":
      return {
        title: "This offer has closed.",
        body: `The welcome offer ran until ${WELCOME_OFFER_CLOSES_LABEL}. You can still add the Fold to your membership at the usual price from your account page.`,
      };
    case "no_subscription":
      return {
        title: "We couldn't find an active membership.",
        body: "This offer upgrades an existing membership, so it needs a live subscription on the same email address you signed in with. If that doesn't sound right, reply to the email we sent you and we'll sort it out.",
      };
    case "already_bundle":
      return {
        title: "You're on the bundle.",
        body: "You have both Ark+ and the Fold. You can see what you're paying and when it renews on your account page.",
      };
    case "gift_running":
      return {
        title: "Your gifted time is still running.",
        body: "This offer starts a new paid term today, which would cut into the membership time you were gifted. Reply to the email we sent you and we'll help you take it without losing any of that time.",
      };
    case "not_eligible":
      return {
        title: "This offer isn't attached to your account.",
        body: "It went out to Ark+ subscribers who joined before 5 October, on the address they subscribed with. If you have more than one email with us, try signing in with the other one — or reply to the email and we'll help.",
      };
    default:
      return {
        title: "We couldn't load your offer.",
        body: "Please try again, or reply to the email we sent you and we'll help.",
      };
  }
}

function OfferPage() {
  const { state, signIn } = useSubscriberAuth();
  // Only what the server told us, or what redeeming turned it into. Whether
  // the visitor is signed in at all is DERIVED below rather than mirrored into
  // state — copying it here meant setting state from an effect on every guest
  // load, for a value already sitting in `state.kind`.
  const [resolved, setResolved] = useState<View | null>(null);

  useEffect(() => {
    if (state.kind !== "member") return;
    let live = true;
    void getWelcomeOffer().then((result) => {
      if (!live) return;
      if (result.kind === "offer") setResolved({ kind: "offer", offer: result.offer });
      else if (result.kind === "ineligible")
        setResolved({ kind: "ineligible", reason: result.reason });
      else setResolved({ kind: "error" });
    });
    return () => {
      live = false;
    };
  }, [state.kind]);

  const view: View =
    state.kind === "loading"
      ? { kind: "loading" }
      : state.kind !== "member"
        ? { kind: "ineligible", reason: "signed_out" }
        : (resolved ?? { kind: "loading" });

  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-12 pb-14 sm:pt-20">
          <div className="eyebrow text-cyan">A welcome offer</div>
          <h1 className="mt-5 max-w-2xl text-fg-strong">
            <span className="display-upright block text-[clamp(2rem,5vw,3.6rem)] leading-[1.05]">
              Add <span className="display text-cyan">the Fold</span> to your
              membership.
            </span>
          </h1>
          <div className="mt-10 max-w-xl">
            <OfferBody
              view={view}
              onSignIn={() => signIn()}
              setView={setResolved}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function OfferBody({
  view,
  onSignIn,
  setView,
}: {
  view: View;
  onSignIn: () => void;
  setView: (v: View) => void;
}) {
  if (view.kind === "loading") {
    return <p className="body-text text-fg-muted">Loading your offer…</p>;
  }

  if (view.kind === "done") {
    return (
      <div>
        <h2 className="font-display text-2xl text-fg-strong">You're in.</h2>
        <p className="mt-4 body-text text-fg-muted">
          The Fold is open to you now — no waiting. Your next bill
          {view.renewsAt ? ` is ${fmtDate(view.renewsAt)}` : ""}.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to="/fold" className={primaryCta}>
            Go to the Fold
          </Link>
          <Link to="/account" className={secondaryCta}>
            View my account
          </Link>
        </div>
      </div>
    );
  }

  if (view.kind === "ineligible" && view.reason === "signed_out") {
    return (
      <div>
        <p className="body-text text-fg-muted">
          Sign in with the email address your Inside Call me Back subscription
          is on, and we'll show you your offer.
        </p>
        <button type="button" className={`${primaryCta} mt-8`} onClick={onSignIn}>
          Sign in
        </button>
      </div>
    );
  }

  if (view.kind === "ineligible" || view.kind === "error") {
    const copy = ineligibleCopy(view.kind === "error" ? "error" : view.reason);
    return (
      <div>
        <h2 className="font-display text-2xl text-fg-strong">{copy.title}</h2>
        <p className="mt-4 body-text text-fg-muted">{copy.body}</p>
        <div className="mt-8">
          <Link to="/account" className={secondaryCta}>
            Go to my account
          </Link>
        </div>
      </div>
    );
  }

  return <OfferConfirm offer={view.offer} setView={setView} />;
}

// The confirm panel. Three questions, in the order a member asks them: what am
// I getting, what does it cost, and what comes off my card right now.
//
// The renewal date gets said out loud because this offer MOVES it — the new
// term starts today — and a date that shifts without being named is the thing
// members write in about.
function OfferConfirm({
  offer,
  setView,
}: {
  offer: WelcomeOffer;
  setView: (v: View) => void;
}) {
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [ageMissing, setAgeMissing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { currency, minorFactor, plan } = offer;
  const money = (minor: number) => formatMinor(minor, currency, minorFactor);
  const cadence = plan === "yearly" ? "a year" : "a month";
  const termLabel =
    plan === "yearly"
      ? "your first year"
      : `your first ${offer.discountedTerms} months`;

  const onConfirm = async () => {
    if (!confirmedAge) {
      setAgeMissing(true);
      return;
    }
    setWorking(true);
    setError(null);
    const result = await redeemWelcomeOffer({
      ageStatement: AGE_STATEMENT.self,
    });
    setWorking(false);
    if (result.ok) {
      setView({
        kind: "done",
        plan: result.plan ?? plan,
        renewsAt: result.renewsAt ?? null,
      });
      return;
    }
    // An eligibility answer is not a retry — the state changed under them.
    if (result.reason) {
      setView({ kind: "ineligible", reason: result.reason });
      return;
    }
    setError(result.error ?? "Something went wrong — please try again.");
  };

  return (
    <div>
      <p className="body-text text-fg-muted">
        You're on Ark+. This moves you to the bundle — Ark+ and the Fold
        together — at a welcome price for {termLabel}.
      </p>

      <dl className="mt-8 divide-y divide-rule border-y border-rule">
        <div className="flex items-baseline justify-between gap-4 py-3">
          <dt className="body-text text-fg-muted">The bundle</dt>
          <dd className="font-display text-fg-strong">
            <span className="text-fg-muted line-through">
              {money(offer.bundleCents)}
            </span>{" "}
            {money(offer.offerCents)} {cadence}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-3">
          <dt className="body-text text-fg-muted">
            {plan === "yearly"
              ? "Then, from next year"
              : `Then, from month ${offer.discountedTerms + 1}`}
          </dt>
          <dd className="font-display text-fg-strong">
            {money(offer.bundleCents)} {cadence}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-3">
          <dt className="body-text text-fg-muted">Due today</dt>
          <dd className="font-display text-fg-strong">
            {offer.dueTodayCents === null
              ? "Shown before you're charged"
              : money(offer.dueTodayCents)}
          </dd>
        </div>
      </dl>

      <p className="mt-4 body-text text-sm text-fg-muted">
        {offer.dueTodayCents === null
          ? "We'll credit whatever is left of the Ark+ you've already paid for against today's charge."
          : "That's the welcome price less a credit for the part of your Ark+ term you've already paid for."}{" "}
        Your billing date moves to today
        {offer.currentRenewsAt
          ? `, instead of ${fmtDate(offer.currentRenewsAt)}`
          : ""}
        , and you'll renew {cadence === "a year" ? "each year" : "each month"}{" "}
        from now on.
        {offer.cancelBooked
          ? " This also calls off the cancellation you'd booked."
          : ""}
      </p>

      <label className="mt-8 flex items-start gap-3">
        <input
          type="checkbox"
          checked={confirmedAge}
          onChange={(e) => {
            setConfirmedAge(e.target.checked);
            if (e.target.checked) setAgeMissing(false);
          }}
          className="mt-1 size-4 shrink-0 accent-cyan"
        />
        <span className="body-text text-fg-muted">{AGE_STATEMENT.self}</span>
      </label>
      {ageMissing ? (
        <p className="mt-2 body-text text-sm text-red-400">
          Please confirm you're 18 or older — the Fold is an adults-only
          community.
        </p>
      ) : null}

      {error ? (
        <p className="mt-6 body-text text-red-400">{error}</p>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          className={primaryCta}
          onClick={() => void onConfirm()}
          disabled={working}
        >
          {working ? "Adding the Fold…" : "Add the Fold"}
        </button>
        <Link to="/account" className={secondaryCta}>
          Not now
        </Link>
      </div>

      <p className="mt-6 body-text text-sm text-fg-muted">
        Open until {WELCOME_OFFER_CLOSES_LABEL}.
      </p>
    </div>
  );
}
