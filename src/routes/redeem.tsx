import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import { redeemGift, type RedeemGiftResult } from "../lib/gift";
import { trackEvent } from "../lib/analytics";

// Where a recipient lands from the gift email's "Claim your gift" link. The
// token is the bearer credential the email carried; claiming requires a signed-in
// session (the server keys the grant on the recipient's Auth0 sub), so guests are
// routed through sign-in first and returned here. Brand-new recipients set a
// password from the email before they reach this page (their Auth0 login is
// provisioned at purchase time).
export const Route = createFileRoute("/redeem")({
  component: RedeemPage,
  validateSearch: (search: Record<string, unknown>): { token?: string } => {
    const token = typeof search.token === "string" ? search.token : undefined;
    return token ? { token } : {};
  },
});

type ClaimState =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "done"; result: Extract<RedeemGiftResult, { ok: true }> }
  | { kind: "error"; message: string; terminal: boolean };

// Server error slugs → recipient-facing copy. `terminal` errors hide the retry
// button (retrying can't change the outcome).
function messageForError(res: Extract<RedeemGiftResult, { ok: false }>): {
  message: string;
  terminal: boolean;
} {
  switch (res.error) {
    case "already_redeemed":
      return { message: "This gift has already been claimed.", terminal: true };
    case "invalid_gift":
      return {
        message:
          "We couldn't find this gift. Use the link from your gift email, or reply to it and we'll help.",
        terminal: true,
      };
    default:
      return {
        message: "Something went wrong claiming your gift. Please try again.",
        terminal: false,
      };
  }
}

const primaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50";
const secondaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 border border-rule-strong px-6 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function RedeemPage() {
  const { token } = Route.useSearch();
  const { state, signIn, refresh } = useSubscriberAuth();
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });

  const onClaim = async () => {
    if (!token) return;
    setClaim({ kind: "claiming" });
    const result = await redeemGift(token);
    if (result.ok) {
      trackEvent("gift_redeemed", { applied: result.applied });
      // Pull fresh entitlements so the rest of the app reflects the new access.
      await refresh();
      setClaim({ kind: "done", result });
    } else {
      setClaim({ kind: "error", ...messageForError(result) });
    }
  };

  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-12 pb-14 sm:pt-20">
          <div className="eyebrow text-cyan">A gift for you</div>
          <h1 className="mt-5 max-w-2xl text-fg-strong">
            <span className="display-upright block text-[clamp(2rem,5vw,3.6rem)] leading-[1.05]">
              Claim your <span className="display text-cyan">Ark+</span> gift.
            </span>
          </h1>

          <div className="mt-10 max-w-xl">
            <RedeemBody
              token={token}
              authKind={state.kind}
              claim={claim}
              onSignIn={() => signIn()}
              onClaim={onClaim}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function RedeemBody({
  token,
  authKind,
  claim,
  onSignIn,
  onClaim,
}: {
  token: string | undefined;
  authKind: "loading" | "guest" | "member";
  claim: ClaimState;
  onSignIn: () => void;
  onClaim: () => void;
}) {
  if (!token) {
    return (
      <Card>
        <p className="text-body-sm">
          This link is missing its gift code. Open the{" "}
          <span className="text-fg-strong">Claim your gift</span> button in your
          gift email, or reply to that email and we'll help.
        </p>
      </Card>
    );
  }

  if (claim.kind === "done") {
    const credited = claim.result.applied === "credit";
    return (
      <Card>
        <p className="eyebrow text-cyan">You're all set</p>
        <p className="mt-4 text-body-sm">
          {credited
            ? "You already have an active membership, so your gift has been added as account credit toward your future renewals."
            : "Your Ark+ membership is active. Set up your private podcast feed and join the community from your welcome page."}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to={credited ? "/account" : "/welcome"} className={primaryCta}>
            {credited ? "Go to your account" : "Get started"} →
          </Link>
        </div>
      </Card>
    );
  }

  if (authKind === "loading") {
    return (
      <Card>
        <p className="text-body-sm text-fg-muted">Checking your account…</p>
      </Card>
    );
  }

  if (authKind === "guest") {
    return (
      <Card>
        <p className="text-body-sm">
          Sign in to claim your gift. If this is your first time, set your
          password using the link in your gift email, then come back and sign in.
        </p>
        <div className="mt-8">
          <button type="button" onClick={onSignIn} className={primaryCta}>
            Sign in to claim →
          </button>
        </div>
      </Card>
    );
  }

  // Signed-in member — ready to claim.
  const claiming = claim.kind === "claiming";
  return (
    <Card>
      <p className="text-body-sm">
        You're signed in. Claim your gift to start your membership — your access
        runs from today and won't auto-renew.
      </p>
      {claim.kind === "error" ? (
        <p role="alert" className="mt-5 text-body-sm text-danger">
          {claim.message}
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap gap-3">
        {claim.kind === "error" && claim.terminal ? (
          <Link to="/account" className={secondaryCta}>
            Go to your account
          </Link>
        ) : (
          <button
            type="button"
            onClick={onClaim}
            disabled={claiming}
            className={primaryCta}
          >
            {claiming ? "Claiming…" : "Claim your gift"} →
          </button>
        )}
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-rule bg-navy-800/40 p-8 sm:p-10">{children}</div>
  );
}
