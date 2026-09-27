import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSubscriberAuth } from "../lib/subscriberAuth";
import {
  claimGiftWithMagicToken,
  giftClaimPending,
  GIFT_TIER_LABEL,
  giftTierFromClaimToken,
  prepareGiftClaim,
  redeemGift,
  resendGiftClaim,
  type RedeemGiftResult,
  type ResendClaimResult,
} from "../lib/gift";
import { trackEvent } from "../lib/analytics";
import {
  clearLandingCredentials,
  getLandingCredential,
  stashUrlCredentials,
} from "../lib/observability";

// Where a recipient lands from the gift email's link. Two shapes:
//   ?mt=…    — the single-email magic link. One click (POST /api/gift/claim)
//              creates/logs-in the recipient and redeems, then routes to the
//              welcome flow. No prior sign-in. This is the normal path.
//   ?token=… — the fallback claim token. Requires a signed-in session
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
  | { kind: "error"; message: string; terminal: boolean; expired?: boolean };

// Server error slugs → recipient-facing copy. `terminal` errors hide the retry
// button (retrying can't change the outcome).
function messageForError(error: string): { message: string; terminal: boolean } {
  switch (error) {
    case "already_redeemed":
      return { message: "This gift has already been claimed.", terminal: true };
    case "expired_link":
      // The page offers a fresh link right under this (ResendLink).
      return { message: "This link has expired.", terminal: true };
    case "invalid_gift":
      return {
        message:
          "We couldn't find this gift. Reply to your gift email and we'll help.",
        terminal: true,
      };
    default:
      return {
        message: "Something went wrong. Please try again.",
        terminal: false,
      };
  }
}

const primaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 bg-cyan px-6 py-3 button-text font-display font-bold tracking-cta text-navy transition hover:bg-fg-strong hover:text-navy-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan disabled:cursor-not-allowed disabled:opacity-50";
const secondaryCta =
  "inline-flex min-h-12 items-center justify-center gap-2 border border-rule-strong px-6 py-3 button-text font-display font-bold text-fg-strong transition hover:border-cyan hover:text-cyan focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan";

function RedeemPage() {
  const search = Route.useSearch();

  // `mt` is a bearer credential: it both logs the holder in and redeems the
  // gift — and `token` is the same thing one sign-in later. Neither should
  // linger in browser history, get shoulder-surfed, or reach Sentry/PostHog.
  //
  // On the normal path (a fresh page load from the email link) main.tsx has
  // ALREADY lifted both out of the URL, before the observability SDKs started,
  // so the search params here are empty and the values come from the holder in
  // lib/observability. The search params only carry them on an in-app
  // navigation to /redeem; the effect below gives that case the same treatment.
  // Captured once via lazy initializers so clearing the URL can't blank them.
  //
  // `token` is exchanged for an HttpOnly server cookie before the sign-in round
  // trip (see TokenClaimBody). The browser never persists the bearer token.
  const [magicToken] = useState(() => search.mt ?? getLandingCredential("mt"));
  const [token] = useState(
    () => search.token ?? getLandingCredential("token"),
  );
  useEffect(() => {
    if (!search.mt && !search.token) return;
    stashUrlCredentials();
  }, [search.mt, search.token]);
  // Any of the three tiers can be gifted; name the right one when the link says.
  const giftTier = giftTierFromClaimToken(magicToken);
  const tierLabel = giftTier ? GIFT_TIER_LABEL[giftTier] : null;

  return (
    <main className="relative">
      <section className="section-hero relative">
        <div className="page-gutter pt-12 pb-14 sm:pt-20">
          <div className="eyebrow text-cyan">A gift for you</div>
          <h1 className="mt-5 max-w-2xl text-fg-strong">
            <span className="display-upright block text-[clamp(2rem,5vw,3.6rem)] leading-[1.05]">
              Claim your{" "}
              {tierLabel ? (
                <>
                  <span className="display text-cyan">{tierLabel}</span>{" "}
                </>
              ) : null}
              gift.
            </span>
          </h1>

          <div className="mt-10 max-w-xl">
            {magicToken ? (
              <MagicClaimBody mt={magicToken} tierLabel={tierLabel} />
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
function MagicClaimBody({ mt, tierLabel }: { mt: string; tierLabel: string | null }) {
  const { refresh } = useSubscriberAuth();
  const navigate = useNavigate();
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });

  const onClaim = async () => {
    setClaim({ kind: "claiming" });
    const result = await claimGiftWithMagicToken(mt);
    if (result.ok) {
      // Spent — don't let it resurface the claim button on a later visit.
      clearLandingCredentials();
      trackEvent("gift_redeemed", { applied: result.applied });
      // Pull the freshly-minted session so the app reflects the new access,
      // then drop into the new-account welcome flow.
      await refresh();
      // A held gift has nothing to show yet — stay here so the recipient reads
      // why. Credit and extend both land on an existing account/subscription —
      // send them to /account; a fresh (or mixed) grant drops into the welcome
      // flow.
      if (result.applied === "held") {
        setClaim({ kind: "done", result });
      } else if (result.applied === "credit" || result.applied === "extended") {
        navigate({ to: "/account" });
      } else {
        navigate({ to: "/welcome", search: { claimed: true } });
      }
      return;
    }
    const failure = messageForError(result.error);
    // A terminal failure (claimed / expired / unknown) is as spent as a success.
    if (failure.terminal) clearLandingCredentials();
    setClaim({ kind: "error", ...failure, expired: result.error === "expired_link" });
  };

  if (claim.kind === "done") return <ClaimDoneCard applied={claim.result.applied} />;

  if (claim.kind === "error") {
    return (
      <Card>
        <p role="alert" className="text-body-sm text-danger">
          {claim.message}
        </p>
        {claim.expired ? <ResendLink mt={mt} /> : null}
        <div className="mt-8 flex flex-wrap gap-3">
          {claim.expired ? null : claim.terminal ? (
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
        Your gift starts today.
      </p>
      <div className="mt-8">
        <button
          type="button"
          onClick={onClaim}
          disabled={claiming}
          className={primaryCta}
        >
          {claiming
            ? "Starting…"
            : tierLabel
              ? `Start your ${tierLabel} membership`
              : "Start your membership"}{" "}
          →
        </button>
      </div>
    </Card>
  );
}

// An expired magic link can be swapped for a fresh one. It goes to the inbox
// the old link was sent to (the server reads the address off the link), which
// is why the page can offer it to whoever is holding the link.
function ResendLink({ mt }: { mt: string }) {
  const [state, setState] = useState<"idle" | "sending" | ResendClaimResult>("idle");

  const onResend = async () => {
    setState("sending");
    setState(await resendGiftClaim(mt));
  };

  if (state === "sent") {
    return (
      <p role="status" className="mt-5 text-body-sm">
        We've emailed you a new link. It's the same gift, so use the newest email.
      </p>
    );
  }
  if (state === "claimed") {
    return (
      <p role="status" className="mt-5 text-body-sm">
        This gift has already been claimed.
      </p>
    );
  }
  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={onResend}
        disabled={state === "sending"}
        className={primaryCta}
      >
        {state === "sending" ? "Sending…" : "Email me a new link"} →
      </button>
      {state === "too_many" ? (
        <p role="alert" className="mt-5 text-body-sm text-danger">
          We've already sent a few new links today. Check your inbox, or reply to
          your gift email and we'll help.
        </p>
      ) : state === "failed" ? (
        <p role="alert" className="mt-5 text-body-sm text-danger">
          We couldn't send a new link. Please try again, or reply to your gift
          email and we'll help.
        </p>
      ) : null}
    </div>
  );
}

// The token/fallback path: claiming needs a signed-in session.
function TokenClaimBody({ token }: { token: string | undefined }) {
  const { state, signIn, refresh } = useSubscriberAuth();
  const [claim, setClaim] = useState<ClaimState>({ kind: "idle" });
  const [claimReady, setClaimReady] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const ready = token ? prepareGiftClaim(token) : giftClaimPending();
    void ready.then((ok) => {
      if (!active) return;
      if (ok && token) clearLandingCredentials();
      setClaimReady(ok);
    });
    return () => {
      active = false;
    };
  }, [token]);

  const onClaim = async () => {
    setClaim({ kind: "claiming" });
    const result = await redeemGift();
    if (result.ok) {
      // The server clears its HttpOnly handoff cookie on this outcome; clear
      // any in-memory copy here as well.
      clearLandingCredentials();
      trackEvent("gift_redeemed", { applied: result.applied });
      await refresh();
      setClaim({ kind: "done", result });
    } else {
      const failure = messageForError(result.error);
      if (failure.terminal) clearLandingCredentials();
      setClaim({ kind: "error", ...failure });
    }
  };

  if (claimReady === null) {
    return (
      <Card>
        <p className="text-body-sm text-fg-muted">Preparing your gift…</p>
      </Card>
    );
  }

  if (!claimReady) {
    return (
      <Card>
        <p className="text-body-sm">
          This link is incomplete. Use the button in your gift email, or reply to
          it and we'll help.
        </p>
      </Card>
    );
  }

  if (claim.kind === "done") return <ClaimDoneCard applied={claim.result.applied} />;

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
          Sign in to claim your gift.
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
        Your gift starts today.
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

// The success screen for either claim path. Only the token path lands here for
// every outcome; the magic-link path navigates away on success and shows it
// just for a held gift, which has nowhere better to go.
function ClaimDoneCard({
  applied,
}: {
  applied: Extract<RedeemGiftResult, { ok: true }>["applied"];
}) {
  // Credit, extend and held all act on an account the recipient already has —
  // the copy differs but all route to /account rather than the new-member
  // welcome.
  const alreadyActive =
    applied === "credit" || applied === "extended" || applied === "held";
  const message =
    applied === "credit"
      ? "You're already a member, so we've added your gift as credit toward your next renewals."
      : applied === "extended"
        ? "You're already a member, so your gift pushes back your next payment."
        : applied === "held"
          ? "You're already a member, so our team will add your gift by hand and email you when it's done."
          : "Your membership is active.";
  return (
    <Card>
      <p className="eyebrow text-cyan">
        {applied === "held" ? "Gift received" : "You're all set"}
      </p>
      <p className="mt-4 text-body-sm">{message}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link to={alreadyActive ? "/account" : "/welcome"} className={primaryCta}>
          {alreadyActive ? "Go to your account" : "Get started"} →
        </Link>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-rule bg-navy-800/40 p-8 sm:p-10">{children}</div>
  );
}
