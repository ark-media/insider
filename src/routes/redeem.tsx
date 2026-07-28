import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import {
  claimGiftWithMagicToken,
  redeemGift,
  type RedeemGiftResult,
} from "../lib/gift";
import { trackEvent } from "../lib/analytics";

// Where a recipient lands from the gift email's link. Two shapes:
//   ?mt=…    — the single-email magic link. One click (POST /api/gift/claim)
//              creates/logs-in the recipient and redeems, then routes to the
//              welcome flow. No prior sign-in. This is the normal path.
//   ?token=… — the legacy/fallback claim token. Requires a signed-in session
//              (the server keys the grant on the recipient's Auth0 sub), so
//              guests sign in first and return here.
export const Route = createFileRoute("/redeem")({
  component: RedeemPage,
  validateSearch: (
    search: Record<string, unknown>,
  ): { token?: string; mt?: string } => {
    const token = typeof search.token === "string" ? search.token : undefined;
    const mt = typeof search.mt === "string" ? search.mt : undefined;
    return { ...(token ? { token } : {}), ...(mt ? { mt } : {}) };
  },
});

type ClaimState =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "done"; result: Extract<RedeemGiftResult, { ok: true }> }
  | { kind: "error"; message: string; terminal: boolean };

// Server error slugs → recipient-facing copy. `terminal` errors hide the retry
// button (retrying can't change the outcome).
function messageForError(error: string): { message: string; terminal: boolean } {
  switch (error) {
    case "already_redeemed":
      return { message: "This gift has already been claimed.", terminal: true };
    case "expired_link":
      return {
        message:
          "This gift link has expired. Reply to your gift email and we'll send you a fresh one.",
        terminal: true,
      };
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
  const { token, mt } = Route.useSearch();

  // `mt` is a bearer credential: it both logs the holder in and redeems the
  // gift. Keep the value in state and drop it from the address bar on mount so
  // it doesn't linger in browser history, get shoulder-surfed, or ride along in
  // any later analytics pageview. (The initial pageview is covered separately by
  // redactSensitiveQuery in lib/observability.) Captured once via the lazy
  // initializer so clearing the URL can't blank it out.
  const [magicToken] = useState(() => mt);
  useEffect(() => {
    if (!mt) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("mt");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [mt]);

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
            {magicToken ? (
              <MagicClaimBody mt={magicToken} />
            ) : (
              <TokenClaimBody token={token} />
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

// The magic-link path: one button confirms, then we redeem + auto-login and go
// to the welcome flow. A confirm button (rather than claiming on page load)
// keeps email link-scanners that auto-open links from consuming the gift.
function MagicClaimBody({ mt }: { mt: string }) {
  const { refresh } = useSubscriberAuth();
  const navigate = useNavigate();
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });

  const onClaim = async () => {
    setClaim({ kind: "claiming" });
    const result = await claimGiftWithMagicToken(mt);
    if (result.ok) {
      trackEvent("gift_redeemed", { applied: result.applied });
      // Pull the freshly-minted session so the app reflects the new access,
      // then drop into the new-account welcome flow.
      await refresh();
      // Credit and extend both land on an existing account/subscription — send
      // them to /account; a fresh (or mixed) grant drops into the welcome flow.
      if (result.applied === "credit" || result.applied === "extended") {
        navigate({ to: "/account" });
      } else {
        navigate({ to: "/welcome", search: { claimed: true } });
      }
      return;
    }
    setClaim({ kind: "error", ...messageForError(result.error) });
  };

  if (claim.kind === "error") {
    return (
      <Card>
        <p role="alert" className="text-body-sm text-danger">
          {claim.message}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          {claim.terminal ? (
            <Link to="/account" className={secondaryCta}>
              Go to your account
            </Link>
          ) : (
            <button type="button" onClick={onClaim} className={primaryCta}>
              Try again →
            </button>
          )}
        </div>
      </Card>
    );
  }

  const claiming = claim.kind === "claiming";
  return (
    <Card>
      <p className="text-body-sm">
        You're one click away. Start your membership — you'll be signed in
        automatically, and your access runs from today and won't auto-renew.
      </p>
      <div className="mt-8">
        <button
          type="button"
          onClick={onClaim}
          disabled={claiming}
          className={primaryCta}
        >
          {claiming ? "Starting…" : "Start your Ark+ membership"} →
        </button>
      </div>
    </Card>
  );
}

// The token/fallback path: claiming needs a signed-in session.
function TokenClaimBody({ token }: { token: string | undefined }) {
  const { state, signIn, refresh } = useSubscriberAuth();
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });

  const onClaim = async () => {
    if (!token) return;
    setClaim({ kind: "claiming" });
    const result = await redeemGift(token);
    if (result.ok) {
      trackEvent("gift_redeemed", { applied: result.applied });
      await refresh();
      setClaim({ kind: "done", result });
    } else {
      setClaim({ kind: "error", ...messageForError(result.error) });
    }
  };

  if (!token) {
    return (
      <Card>
        <p className="text-body-sm">
          This link is missing its gift code. Open the{" "}
          <span className="text-fg-strong">Start your membership</span> button in
          your gift email, or reply to that email and we'll help.
        </p>
      </Card>
    );
  }

  if (claim.kind === "done") {
    const applied = claim.result.applied;
    // Credit and extend both act on an account the recipient already has — the
    // copy differs but both route to /account rather than the new-member welcome.
    const alreadyActive = applied === "credit" || applied === "extended";
    const message =
      applied === "credit"
        ? "You already have an active membership, so your gift has been added as account credit toward your future renewals."
        : applied === "extended"
          ? "You already have an active subscription, so your gift has extended it — your next paid renewal is deferred by the length of the gift."
          : "Your Ark+ membership is active. Set up your private podcast feed and join the community from your welcome page.";
    return (
      <Card>
        <p className="eyebrow text-cyan">You're all set</p>
        <p className="mt-4 text-body-sm">{message}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link to={alreadyActive ? "/account" : "/welcome"} className={primaryCta}>
            {alreadyActive ? "Go to your account" : "Get started"} →
          </Link>
        </div>
      </Card>
    );
  }

  if (state.kind === "loading") {
    return (
      <Card>
        <p className="text-body-sm text-fg-muted">Checking your account…</p>
      </Card>
    );
  }

  if (state.kind === "guest") {
    return (
      <Card>
        <p className="text-body-sm">
          Sign in to claim your gift, then come back to this page.
        </p>
        <div className="mt-8">
          <button type="button" onClick={() => signIn()} className={primaryCta}>
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
