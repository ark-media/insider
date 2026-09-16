import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { trackEvent } from "../lib/analytics";
import { foldGateAudience, type FoldAudience } from "../lib/foldGate";
import { useSubscriberAuth } from "../lib/subscriberAuth";

// The landing half of the Fold login gate.
//
// When someone without the `circle` entitlement opens a Fold link, the Auth0
// post-login Action (auth0/actions/post-login.js) abandons the login
// transaction and sends them here — `/plus?from=fold` — so Circle never gets a
// callback and never auto-provisions them a member. Until this notice existed
// they landed on a cold pricing page with no idea why they'd been bounced out
// of a link they'd just clicked.
//
// The Action denies for two different people, and they need opposite
// instructions, so the notice reads the session rather than the query param
// alone:
//
//   - an Ark+-only member, who must ADD the axis to the subscription they
//     already have (buying from the pricing cards below would start a second
//     subscription, which the single-active-subscription guard then refuses);
//   - someone with no live membership, for whom those cards are exactly right.
//
// What it deliberately does NOT do is claim a membership "ended". The
// subscription.deleted webhook DELETES the Neon row (server/routes/stripe/
// webhook.ts), so a lapsed member and someone who never held the Fold are
// indistinguishable from here — hence "join or renew", which is true of both.

const COPY: Record<FoldAudience, { title: string; body: string; cta: string }> =
  {
    guest: {
      title: "You'll need to be signed in.",
      body: "That link goes to the Fold, our members-only community. There's no session on this device, so sign in and we'll tell you exactly where you stand.",
      cta: "Sign in",
    },
    "no-membership": {
      title: "The Fold is members-only.",
      body: "Your account doesn't include it right now. Join or renew below and the link you clicked will work straight away.",
      cta: "See membership options",
    },
    "ark-plus-only": {
      title: "The Fold isn't part of your membership yet.",
      body: "Ark+ covers the private feeds. Adding the Fold takes a minute from your account — we'll adjust the subscription you already have rather than starting a second one.",
      cta: "Add the Fold",
    },
    member: {
      title: "You're already in.",
      body: "Your membership covers the Fold, so that link should work now. Try it again, or head in from here.",
      cta: "Go to the Fold",
    },
  };

const CTA_CLASS =
  "inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap border border-cyan bg-cyan px-5 button-text font-display font-bold text-navy transition hover:bg-transparent hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

export function FoldGateNotice() {
  const { state, signIn } = useSubscriberAuth();
  const audience = foldGateAudience(state);

  // Once per landing, and only once the session has resolved — this is the one
  // place that can count how many people the Fold gate turns away, and what
  // each of them was actually missing.
  const tracked = useRef(false);
  useEffect(() => {
    if (audience === null || tracked.current) return;
    tracked.current = true;
    trackEvent("fold_gate_bounced", { audience });
  }, [audience]);

  if (audience === null) return null;

  const copy = COPY[audience];

  return (
    // A div, not a section: the zebra striping in index.css bands every
    // section/article child of #main-content, so a section here would flip the
    // parity of every band below it on /plus.
    //
    // role="status", not "alert" — nothing has gone wrong, and a Fold link is
    // most often clicked by someone who simply hasn't bought this part yet.
    <div role="status" className="border-b border-cyan/30 bg-cyan/10">
      <div className="page-gutter flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
        <div className="max-w-2xl">
          <p className="label text-cyan">The Fold</p>
          <p className="mt-2 font-display text-[17px] font-bold text-fg-strong">
            {copy.title}
          </p>
          <p className="mt-2 text-body-sm text-fg">{copy.body}</p>
        </div>

        {audience === "guest" ? (
          <button
            type="button"
            // No argument: signIn defaults returnTo to the current path AND
            // search, so they come back to `?from=fold` and this notice
            // re-renders as whichever of the three answers applies to them.
            onClick={() => signIn()}
            className={CTA_CLASS}
          >
            {copy.cta}
          </button>
        ) : null}

        {audience === "no-membership" ? (
          // The cards are already on this page; this is a jump, not a route
          // change. <Pricing> owns the `pricing` id.
          <a href="#pricing" className={CTA_CLASS}>
            {copy.cta}
          </a>
        ) : null}

        {audience === "ark-plus-only" ? (
          <Link to="/account" className={CTA_CLASS}>
            {copy.cta}
          </Link>
        ) : null}

        {audience === "member" ? (
          <Link to="/fold" className={CTA_CLASS}>
            {copy.cta}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
