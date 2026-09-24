export type UserFeed = {
  /**
   * The SHOW id (`pod_<uuid>`), not the private feed token. Beehiiv rotates
   * `pod_feed_<uuid>` whenever a feed is reissued, and this id is what we send
   * back through `?feed=` and the setup marker — so it has to be the stable one.
   */
  id: string;
  /** Beehiiv's own show title — the same one the member's podcast app shows. */
  name: string;
  url: string;
  description?: string;
  image_url?: string;
  /**
   * Beehiiv's per-app deep links, keyed by app: `apple`, `castro`, `overcast`,
   * `pocket_casts`. That is the complete set — Spotify is not among them and
   * goes through the server-side hand-off at /api/me/feeds/spotify instead.
   */
  protocolLinks?: Record<string, string>;
  // Authoritative activation state: Beehiiv reports it on the feed itself and
  // through the `podcasts.private_feed.activated` webhook.
  activated?: boolean;
  activated_at?: string | null;
  // Optimistic server-side marker: the member took a setup action but the
  // webhook hasn't landed yet. The setup page treats a feed as done if it is
  // `activated` OR `pending` (see feedIsSetUp).
  pending?: boolean;
  // Opened on Spotify from the post-link follow checklist. The server row is
  // the only record — see persistSpotifyFollowOpened. Not a confirmed follow:
  // Spotify reports none.
  spotify_follow_opened?: boolean;
};

// A feed counts as "set up" once it's either confirmed (Beehiiv reports it
// activated) or pending (the member took a setup action and we recorded an
// optimistic server-side marker).
export function feedIsSetUp(feed: UserFeed): boolean {
  return feed.activated === true || feed.pending === true;
}

import type {
  DebundlePrice,
  OfferKind,
  RetentionOffer,
  SaveIntent,
} from "../../shared/retention";

// The two independent access axes: arkPlus → the private feed, circle → the
// Fold. Derived server-side from the tier; every gate checks an entitlement,
// never the tier (tasks/entitlement-tiers.md §2).
type Entitlements = { arkPlus: boolean; circle: boolean };

// The SKU the member holds (billing/copy). 'free' = logged-in via Auth0 with no
// membership. Kept apart from `entitlements` — a bundle and an ark-plus member
// both have arkPlus, but they're different SKUs.
type Tier = "ark-plus" | "circle" | "bundle" | "free";

// Per-axis access for account settings (T7.1): what the member holds on each
// entitlement axis and from what source. A gifted axis shows its term-end date
// (`expiresAt`); a subscription shows its renewal (`renewsAt`) or, if canceling,
// its access-until date (`expiresAt` = cancel_at). Recipients are members with
// an expiry, not subscribers, so the UI needs these facts per axis.
export type AxisAccess = {
  active: boolean;
  source: "subscription" | "gift" | null;
  expiresAt: string | null;
  renewsAt: string | null;
};

export type Me = {
  email: string;
  tier: Tier;
  entitlements: Entitlements;
  // The name to greet by, or null when we hold none they gave us — a name we
  // manufactured from their email never reaches here (shared/profile-name.ts).
  // Never fall back to the email for a greeting; drop the greeting instead.
  firstName?: string | null;
  // Present on every /api/me response (computed server-side). Optional-typed only
  // to stay resilient to a stale cached response; the UI guards for it.
  axes?: { arkPlus: AxisAccess; circle: AxisAccess };
  feeds: UserFeed[];
};

// Every authenticated request rides the httpOnly session cookie (`ark_session`
// or `ark_checkout`), attached by credentials:'include'. There is no client-
// held token — the browser never sees one.

// Resolves to `null` for a genuine guest (401 — no valid session) and to a `Me`
// for a signed-in member. A network failure or non-401 server error THROWS, so
// the auth provider can distinguish "logged out" from "couldn't reach the
// server" and surface an error+retry instead of silently demoting to guest.
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me failed (${res.status})`);
  return (await res.json()) as Me;
}

// Every call that changes what a member is billed goes through here.
//
// The server only lets those through for a member who actually signed in — an
// emailed code or Google. A session that came from a link in one of our emails
// (or the brief post-payment one) can read the account and set up feeds, but is
// answered 401 `reauth_required` on billing. That isn't an error to show and
// leave: send them through sign-in and straight back to the page they were on,
// where the same click now works. The caller still gets the response, so the
// server's sentence shows for the moment before the navigation lands.
async function billingFetch(input: string, init: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: string } | null;
    if (body?.code === "reauth_required") {
      const here = window.location.pathname + window.location.search;
      window.location.assign(
        `/api/auth/login?returnTo=${encodeURIComponent(here)}`,
      );
    }
  }
  return res;
}

export async function cancelSubscription(input: {
  // `offerOutcome` records whether a retention offer was shown first; defaults
  // to 'not_offered'. The reasons/note are collected *after* this commits (the
  // member sees "cancelled" first) via submitCancellationSurvey, keyed by the
  // survey_id this returns.
  offerOutcome?: "declined" | "not_offered";
}): Promise<{
  ok: boolean;
  access_until?: string;
  // The survey row's id, so the reasons can be attached afterward. Null when no
  // DB is configured (preview envs) — the survey step then just no-ops.
  survey_id?: string | number | null;
  error?: string;
}> {
  // Non-2xx still carries a JSON {ok:false, error} body we can surface; only a
  // network failure or a non-JSON error page (e.g. a proxy 502) lands in the
  // catch. Without it the rejection escapes the click handler and strands the
  // page on its in-flight state.
  try {
    const res = await billingFetch("/api/stripe/cancel-subscription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        offer_outcome: input.offerOutcome ?? "not_offered",
      }),
    });
    return (await res.json()) as {
      ok: boolean;
      access_until?: string;
      survey_id?: string | number | null;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Attach the member's cancellation reasons (multi-select) + optional free-text
// note to the survey row a cancel created. Best-effort: the cancel already
// committed, so a failure here just loses the reasons — the caller shouldn't
// block the member on it.
export async function submitCancellationSurvey(input: {
  surveyId: string | number;
  reasons: string[];
  note?: string;
}): Promise<{ ok: boolean }> {
  try {
    const res = await fetch("/api/stripe/cancellation-survey", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        survey_id: input.surveyId,
        reasons: input.reasons,
        note: input.note,
      }),
    });
    const json = (await res.json()) as { ok?: boolean };
    return { ok: Boolean(json.ok) };
  } catch {
    return { ok: false };
  }
}

// Undo a pending cancel: the server clears cancel_at_period_end so the
// membership renews normally again. Returns the next charge date for the
// confirmation message.
export async function reactivateSubscription(): Promise<{
  ok: boolean;
  next_charge_at?: string | null;
  error?: string;
}> {
  try {
    const res = await billingFetch("/api/stripe/reactivate-subscription", {
      method: "POST",
      credentials: "include",
    });
    return (await res.json()) as {
      ok: boolean;
      next_charge_at?: string | null;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// The card the next bill will be charged to. Null whenever we can't read one —
// the plan card then omits the payment-method line rather than guessing.
export type CardOnFile = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type MySubscription = {
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  pendingChange?: boolean;
  scheduledTier?: "ark-plus" | "circle" | "bundle" | "free" | null;
  // The cadence that pending change lands on; null when nothing is scheduled.
  scheduledPlan?: "monthly" | "yearly" | null;
  periodEnd?: string | null;
  plan?: "monthly" | "yearly" | null;
  // What the next bill is. `amountCents` is null when the subscription's price
  // is quoted in a different currency than it bills in (currency_options), so
  // the account page shows the renewal date without inventing a figure.
  amountCents?: number | null;
  currency?: string | null;
  minorFactor?: number;
  card?: CardOnFile | null;
};

// The signed-in member's plan, cancel schedule, price and card on file, from
// GET /api/stripe/my-subscription. Drives the account page's plan card and its
// persistent "set to cancel" state, so a member who already cancelled doesn't
// see the cancel option again after a reload.
//
// NULL means the read failed, and callers must keep it distinguishable from a
// healthy subscription. Degrading into `{cancelAtPeriodEnd:false}` is
// byte-for-byte what a live, uncancelled subscription looks like — so a Stripe
// outage would render a confident "Active" badge to a member whose
// subscription may in fact have been set to cancel. Degrading gracefully is
// right; degrading INTO an assertion is not.
export async function getMySubscription(): Promise<MySubscription | null> {
  try {
    const res = await fetch("/api/stripe/my-subscription", {
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as MySubscription;
  } catch {
    return null;
  }
}

// Replacing the card on file is two calls around Stripe's own confirmation:
// this one returns the SetupIntent client secret that mounts the Payment
// Element, and saveUpdatedCard below bills the membership to the card once
// Stripe has confirmed it. The server's error strings are written for members,
// so they're shown as-is; only a response without one gets the generic line.
export async function createCardSetupIntent(): Promise<
  { ok: true; clientSecret: string } | { ok: false; error: string }
> {
  try {
    const res = await billingFetch("/api/stripe/card-setup-intent", {
      method: "POST",
      credentials: "include",
    });
    const body = (await res.json().catch(() => ({}))) as {
      clientSecret?: string;
      error?: string;
    };
    if (res.ok && body.clientSecret) {
      return { ok: true, clientSecret: body.clientSecret };
    }
    return { ok: false, error: memberFacingError(res.status, body.error) };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// The card comes back so the page can name it straight away. It's null when
// Stripe didn't return a readable card, which still means the save worked.
export async function saveUpdatedCard(setupIntentId: string): Promise<
  { ok: true; card: CardOnFile | null } | { ok: false; error: string }
> {
  try {
    const res = await billingFetch("/api/stripe/update-card", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup_intent_id: setupIntentId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      card?: CardOnFile | null;
      error?: string;
    };
    if (res.ok && body.ok) return { ok: true, card: body.card ?? null };
    return { ok: false, error: memberFacingError(res.status, body.error) };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// The card routes answer 404, 409, 429 and 502 with a sentence written for the
// member. Everything else is a machine code ("bad_origin", "not_configured") or
// a malformed request, neither of which means anything to the person reading.
function memberFacingError(status: number, error: string | undefined): string {
  if (status === 401) return "Your session has expired. Sign in again to update your card.";
  if (error && [404, 409, 429, 502].includes(status)) return error;
  return "Could not update your card — please try again.";
}

// Prices behind the bundle "keep any services?" selector: the current bundle
// price plus what each product costs alone (its standalone catalog price and the
// bounded intro rate it lands on first). Null when unavailable (no live sub /
// Stripe hiccup) — the selector then renders without price lines.
export type BundleBreakdown = {
  plan: "monthly" | "yearly";
  // What every amount below is in: the subscription's own currency.
  currency: string;
  minorFactor: number;
  bundleCents: number;
  arkPlus: DebundlePrice;
  circle: DebundlePrice;
};

export async function getBundleBreakdown(): Promise<BundleBreakdown | null> {
  try {
    const res = await fetch("/api/stripe/bundle-breakdown", {
      credentials: "include",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { breakdown: BundleBreakdown | null };
    return json.breakdown;
  } catch {
    return null;
  }
}

// What adding the missing axis does to a single-axis member's subscription:
// the Bundle price that REPLACES their current one (never a second charge
// beside it), in the currency their subscription actually bills in, plus the
// renewal date the switch leaves untouched. Null when there's no live
// subscription to change; `bundleCents` alone is null when Stripe's price
// lookup failed, and the confirm step then renders without price lines.
export type BundleUpgradePreview = {
  plan: "monthly" | "yearly";
  currency: string;
  minorFactor: number;
  currentCents: number | null;
  bundleCents: number | null;
  renewsAt: string | null;
};

// Deliberately three outcomes, not two. "No live subscription to change" and
// "the request failed" are opposite instructions to the caller — the first
// means fall back to buying the axis standalone, the second means say so and
// offer a retry — and collapsing them into `null` routed a member with a
// perfectly healthy subscription into a SECOND one whenever the endpoint
// hiccuped.
export type BundleUpgradePreviewResult =
  | { kind: "preview"; preview: BundleUpgradePreview }
  | { kind: "none" }
  | { kind: "error" };

export async function getBundleUpgradePreview(): Promise<BundleUpgradePreviewResult> {
  try {
    const res = await fetch("/api/stripe/bundle-upgrade-preview", {
      credentials: "include",
    });
    if (!res.ok) return { kind: "error" };
    const json = (await res.json()) as { preview: BundleUpgradePreview | null };
    return json.preview ? { kind: "preview", preview: json.preview } : { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}

// The ordered save offers for a tier-aware cancel/debundle flow. The server
// resolves cadence + amounts from Stripe and window-suppresses coupons. Any
// failure degrades to no offers so the flow proceeds to reason/confirm. The two
// debundle intents carry no offers at all — only `standalone`, the price the
// kept product continues at.
export async function getSaveOffers(
  intent: SaveIntent,
): Promise<{ offers: RetentionOffer[]; standalone: DebundlePrice | null }> {
  try {
    const res = await fetch(
      `/api/stripe/save-offers?intent=${encodeURIComponent(intent)}`,
      { credentials: "include" },
    );
    if (!res.ok) return { offers: [], standalone: null };
    return (await res.json()) as {
      offers: RetentionOffer[];
      standalone: DebundlePrice | null;
    };
  } catch {
    return { offers: [], standalone: null };
  }
}

// Accept a coupon-backed save offer (supporter / affordability /
// affordability). The server re-derives the coupon for
// (intent, cadence), attaches it, and clears any pending cancel. Plan switches
// go through changeTier instead.
export async function acceptSaveOffer(
  intent: SaveIntent,
  kind: OfferKind,
): Promise<{
  ok: boolean;
  kind?: OfferKind;
  percentOff?: number | null;
  amountOff?: number | null;
  durationMonths?: number | null;
  next_charge_at?: string;
  error?: string;
}> {
  try {
    const res = await billingFetch("/api/stripe/accept-save-offer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ intent, kind }),
    });
    return (await res.json()) as {
      ok: boolean;
      kind?: OfferKind;
      percentOff?: number | null;
      amountOff?: number | null;
      durationMonths?: number | null;
          next_charge_at?: string;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Switch tier / plan / PWYC amount on the member's existing subscription
// (task 14). Gaining an entitlement applies immediately and prorated; losing one
// lands at period end. The server derives direction and timing.
export async function changeTier(input: {
  tier: "ark-plus" | "circle" | "bundle";
  plan: "monthly" | "yearly";
  customAmountCents?: number;
  // Set on a debundle so the server records the win-back cancellation record
  // (what was kept). Omitted for a plain upgrade/PWYC change.
  retainedProduct?: "kept-circle" | "kept-ark-plus";
  // On a debundle, whether a save offer was shown-and-declined first, so the
  // win-back record reads 'declined' vs 'not_offered' like the full-cancel path.
  offerOutcome?: "declined" | "not_offered";
  // The 18+ sentence the member ticked when this change is what grants them the
  // Fold, recorded on the subscription. Omitted for every other change — a
  // missing key reads as "never asked", which is the truth for a PWYC tweak.
  ageStatement?: string | null;
}): Promise<{
  ok: boolean;
  changed?: boolean;
  timing?: "immediate" | "period_end";
  effective_at?: string;
  // On a debundle, the win-back row's id, so the survey that follows can attach
  // the member's reasons to it. Null for a plain upgrade/PWYC (no row written)
  // and in a DB-less preview env — the survey step then just no-ops.
  survey_id?: string | number | null;
  error?: string;
}> {
  try {
    const res = await billingFetch("/api/stripe/change-tier", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        tier: input.tier,
        plan: input.plan,
        custom_amount_cents: input.customAmountCents,
        retained_product: input.retainedProduct,
        offer_outcome: input.offerOutcome,
        age_statement: input.ageStatement ?? undefined,
      }),
    });
    return (await res.json()) as {
      ok: boolean;
      changed?: boolean;
      timing?: "immediate" | "period_end";
      effective_at?: string;
      survey_id?: string | number | null;
      error?: string;
    };
  } catch {
    return { ok: false, error: "Something went wrong — please try again." };
  }
}

// Persist the optimistic "these feeds are set up" marker server-side so it
// survives reloads and follows the member across devices while Beehiiv's
// activation webhook catches up. Fire-and-forget: failures are swallowed
// because the in-memory optimistic state still stands and the webhook remains
// authoritative — a persistence blip must never surface an error on a setup
// click. Ids are SHOW ids (see UserFeed.id).
export async function persistFeedsSetUp(feedIds: string[]): Promise<void> {
  if (feedIds.length === 0) return;
  try {
    await fetch("/api/me/feeds/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ feed_ids: feedIds }),
    });
  } catch {
    /* optimistic UI stands; webhook reconciles */
  }
}

// Record that the member opened this show on Spotify from the follow
// checklist. Resolves false when the write didn't land, so the caller can
// take its optimistic tick back rather than show one the server doesn't hold.
export async function persistSpotifyFollowOpened(showId: string): Promise<boolean> {
  try {
    const res = await fetch("/api/me/feeds/spotify-follow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ show_id: showId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Ask Beehiiv to email the member their private feed URL and setup
// instructions. Beehiiv owns the template and sends to the address on the
// subscription, so this takes no arguments — the member can't send it anywhere
// but their own inbox.
export async function sendFeedEmail(
  /** Which show to send — the SHOW id, since a member has one feed per show. */
  showId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/me/feeds/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ show_id: showId }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    if (res.status === 429) {
      return { ok: false, error: "Too many requests — please wait a few minutes." };
    }
    if (body?.error === "no_feed_yet") {
      return {
        ok: false,
        error: "Your feed is still being set up. Give it a minute and try again.",
      };
    }
    return { ok: false, error: "Could not send the email. Please try again." };
  } catch {
    return { ok: false, error: "Could not reach the server. Please try again." };
  }
}
