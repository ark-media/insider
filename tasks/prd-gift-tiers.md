# Gift Tiers — Task Breakdown

**Goal:** Let users gift **Ark+**, **Community**, or **Bundle** (currently Ark+ only), priced **per-currency via Stripe `currency_options`** (not Adaptive Pricing) — matching the subscription checkout flow.

## Current state (baseline)

- Gifts are one-time payments (`mode: 'payment'`) using **inline `price_data`/`product_data`** — no Stripe products.
- Price is a fixed USD amount from `GIFT_PRICES_CENTS` (`6mo`=$48, `1yr`=$80), tier-agnostic.
- Tier is **hardcoded to `ark-plus`** in the webhook (`server/routes/stripe/webhook.ts:335`).
- Currency uses `adaptive_pricing: { enabled: true }` (`server/routes/gift.ts:142-147`) — **inert**, because `currency_options` on the subscription catalog disables account-level Adaptive Pricing. Gifts charge USD only today.

## Decisions

- **D1 — Gift pricing per tier (RESOLVED).** USD anchors, `currency_options` for the rest:
  | Tier | 6mo | 1yr |
  |------|-----|-----|
  | Ark+ | $48 | $80 |
  | Community | $48 | $80 |
  | Bundle | $75 | $130 |
- **D2 — Product structure.** Recommended: 3 one-time gift products mirroring subscriptions, with lookup keys `gift_<tier>_6mo` / `gift_<tier>_1yr`. Confirm naming.
- **D3 — Bundle-gift entitlement on redemption.** A gift-activated (non-subscription) Bundle grants both `ark_plus` and `circle` axes.
- **D4 — Gift stacking model.** Stack **per entitlement axis**. Replace the single `gift_expires_at` column with `ark_plus_gift_expires_at` + `circle_gift_expires_at`; derive `tier` from which axes are live. Each gift extends only the axes it covers; Bundle extends both. Same-axis gift term → extend expiry (existing `fromMs` logic, per-axis); no axis yet → start term from today.
- **D5 — Paid-sub overlap (RESOLVED, Basis B / value-conserving).** When the recipient already has a live *paid* subscription on an axis the gift covers: grant a term on any axis they lack, and credit the remainder: `creditCents = gift.amount_cents − Σ(standalone gift price of each granted axis for the term)`, clamped to `[0, gift.amount_cents]`. If all covered axes overlap a paid sub → grant nothing, credit the full gift amount (today's behavior). E.g. Bundle 1yr ($130) to an Ark+ subscriber → grant Circle 1yr term ($80) + credit $50.

---

## Phase 1 — Stripe catalog: provision gift products

**T1.1** Add gift products to `scripts/stripe-catalog.ts` alongside the subscription catalog.
- 3 one-time products (Ark+, Community, Bundle), each with two one-time (`recurring: undefined`) prices: `gift_<tier>_6mo`, `gift_<tier>_1yr`.
- Each price carries USD `unit_amount` + `currency_options` for all `CURRENCIES` (same 40-currency list as subscriptions).
- Product `metadata`: `catalog_key`, `entitlements` (`ark_plus` / `circle` / `ark_plus,circle`), `kind: 'gift'`, `term`.
- **Acceptance:** running the script provisions/updates 3 gift products + 6 prices; re-running is idempotent (keyed by lookup key / metadata).

## Phase 2 — Server price resolution

**T2.1** Extend `server/lib/pricing.ts` to resolve gift prices per `(tier, term, currency)`.
- Add a `giftPriceLookupKey(tier, term)` and a resolver returning `{ priceId, productId, floors }` (reuse `resolveCatalogPrice` shape / `currency_options` → floors map, including zero-decimal handling).
- **Acceptance:** resolver returns correct minor-unit amount for each tier/term/currency; throws loudly if a supported currency is missing (parity with subscription resolver).

**T2.2** Retire / repurpose `GIFT_PRICES_CENTS` in `server/lib/activation.ts`.
- Term-length policy (`GIFT_TERM_DAYS`) stays; the fixed USD price table is superseded by the catalog resolver. Keep only if needed as a fallback.
- **Acceptance:** no code path reads a hardcoded gift USD price for the charge amount.

## Phase 3 — Checkout session (`server/routes/gift.ts`)

**T3.1** Accept and validate a `tier` param in `POST /api/gift/create-checkout` (default/guard like `coerceTier`).

**T3.2** Replace inline fixed-USD `price_data` with the resolved gift price for `(tier, term, currency)`; set session `currency` to the selected currency so Stripe charges the matching `currency_options` amount.

**T3.3** **Remove `adaptive_pricing`** from the gift session (it's inert and conflicts with the per-currency model).

**T3.4** Put `tier` (and `term`, `currency`) into PaymentIntent `metadata` so the webhook can read them.
- **Acceptance:** creating a gift checkout for each tier/currency produces a session that charges the correct per-currency amount; no `adaptive_pricing` on the session.

## Phase 4 — Webhook (`server/routes/stripe/webhook.ts`)

**T4.1** In `handleGiftPaymentIntent` (~line 318-340), read `tier` from PI metadata instead of hardcoding `ark-plus`; write the gift row with the real tier.
- **Acceptance:** gift row `tier` reflects the purchased tier for all three tiers; existing Ark+ path unchanged.

## Phase 5 — Per-axis stacking + redemption (`server/routes/gift.ts`, membership schema)

**T5.0** Schema migration: replace `gift_expires_at` with `ark_plus_gift_expires_at` + `circle_gift_expires_at` on the membership row; derive effective `tier` from which axes are live (both → bundle, one → that tier). (Greenfield — no backfill.)

**T5.1** Rewrite `redeemGiftForRecipient` (`gift.ts:347`) to stack **per axis** (D4): for each axis the gift covers, extend that axis's expiry if a gift term is live, else start a term from today. Bundle applies to both axes. Same-tier repeat gifts must still stack duration.

**T5.2** Paid-sub overlap (D5): for axes the recipient already pays for, apply credit via `applyGiftAsCredit`; for axes they lack, grant the term. (Today `canCredit` diverts the *whole* gift to credit — split it per axis.)

**T5.3** Verify entitlement sync handles the `circle` and `ark_plus,circle` axes for gift-activated (non-subscription) memberships — SC feed for Ark+/Bundle, Circle provisioning for Community/Bundle, Beehiiv/newsletter axis.
- **Acceptance:** redeeming each tier as a new recipient activates the correct entitlements; cross-axis stacking (Ark+ gift + Community gift = both axes live with independent expiries) works; Bundle-on-Ark+ extends/credits ark_plus and grants circle.

## Phase 6 — Client

**T6.1** Add a **tier selector** to `src/components/GiftCheckoutModal.tsx` (Ark+ / Community / Bundle) alongside the existing term selector.

**T6.2** Thread `tier` through `src/lib/gift.ts` into the create-checkout call.

**T6.3** Show **per-currency** gift pricing in the modal (reuse the currency-detection/selector + per-currency display used by the subscription checkout).

**T6.4** Update `src/routes/plus/gift.tsx` copy/entry points for multi-tier gifting.
- **Acceptance:** user can pick tier + term, sees the price in their currency, and completes checkout.

## Phase 7 — Account settings & gift visibility

Recipients are members with an expiry, not subscribers — account settings must show *what they have and until when* (per axis) and give a gift-safe path to the axis they lack.

- **D6 (RESOLVED)** — layout: **per-axis entitlement rows** (one row per axis: Ark+, Community), not a single plan card.
- **D7 (RESOLVED)** — missing-axis CTA sells the **standalone axis subscription** (Community-only / Ark+-only), reusing the existing per-currency `CheckoutModal`. Never offer Bundle while a live gift covers an axis (would double-pay the gifted axis).
- **D8 (RESOLVED)** — expiry conversion: in-app **banner + reminder email** via the existing reminder cron (`server/lib/feed-reminders.ts` / `feed-reminder-email.ts`, Resend).
- **D9 (RESOLVED, lightweight)** — no standalone feature. At gift expiry, if the recipient already holds the *other* axis via a live paid sub, the banner (T7.4) and email (T7.5) offer **switch-to-Bundle via change-tier** (in-branch, `server/routes/stripe/routes.ts`) instead of a standalone sub; otherwise the standard standalone CTA. (cancellation-flows is merged, so `retention.ts` / `cancellation.ts` / change-tier are all in-branch.)

**T7.1** Extend `/api/me` (`server/routes/me.ts` + `server/lib/entitlement-resolver.ts`) to return **per-axis** `{ active, source: 'gift'|'subscription', expiresAt }` from the new schema columns.

**T7.2** Render per-axis entitlement rows in account settings (`src/routes/account/`) — each row shows access, source (🎁 Gift / Subscription), and expiry/renewal date.

**T7.3** Missing-axis CTA (gift-aware): offer only axes not held by any source; open the standalone-tier `CheckoutModal`; suppress Bundle while a gift covers an axis.

**T7.4** Near-expiry banner in account settings for gifted axes approaching expiry.

**T7.5** Gift-expiry reminder email via the existing reminder cron + Resend.
- **Acceptance:** a gifted-Ark+ member sees an Ark+ row (gift, expiry) + a "Get Community" CTA that opens the Community standalone checkout; near expiry they see a banner and receive a reminder email.

## Phase 8 — Verification

**T8.1** Browser test (Chrome DevTools MCP): full gift purchase → redemption for one tier in a non-USD currency; confirm Stripe charges the `currency_options` amount, not USD.

**T8.2** Confirm no regression to Ark+ gifting and to subscription checkout (shared `pricing.ts` / catalog script).

---

## Notes / risks

- **Per-currency is a fix, not just a feature:** gifts charge USD-only today because of the inert `adaptive_pricing`; Phases 2-3 are what actually enable per-currency.
- **Gift prices are independent** of subscription prices — don't derive gift amounts from subscription floors.
- **One-time vs recurring:** gift prices must be non-recurring; subscription (recurring) prices can't be reused in `mode: 'payment'`.
- Keep `scripts/stripe-catalog.ts` `CURRENCIES` and `pricing.ts` `SUPPORTED_CURRENCIES` in sync (existing invariant).
