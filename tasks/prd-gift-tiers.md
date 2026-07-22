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
- **D5 — Paid-sub overlap (RESOLVED, extend-first).** A gift delivers exactly the coverage its price buys, at the tier purchased — as **time** wherever there's a subscription to extend, and as **credit** only when the gift is already fully contained in what the recipient owns. Resolve **per axis the gift covers**:
  - **Axis the recipient lacks** → grant a fresh term on that axis (or stack onto a live gift term, per D4).
  - **Axis covered by a live *single-axis* or *exact-tier* paid sub** → **extend** that subscription by the gift term (defer billing): monthly → pause `term` of charges (`pause_collection`); annual → push the renewal / period end out by `term`. No credit.
  - **Single-axis gift landing entirely inside a Bundle sub** (nothing to add, can't pause part of a bundle) → **credit the full gift amount** to the Stripe customer balance; no new access.
  - Worked examples: *Bundle 1yr ($130) → Ark+ subscriber* = grant Circle 1yr **+** extend the Ark+ sub +1yr = a full bundle year (the bundle price **is** the price of both axes for a year; the discount vs two standalone gifts is intended, not over-delivery). *Ark+ 1yr ($80) → Bundle holder* = credit $80. *Bundle 1yr → Bundle subscriber* = extend the bundle +1yr.
  - This supersedes the earlier Basis-B *credit-the-remainder* model: credit is now the **fallback** for the bundle-subset case only, never the primary path.
- **D10 — N1 credit currency (RESOLVED, catalog-denominated, no FX).** The bundle-subset credit (D5 case 3) is denominated from the **gift catalog in the recipient's *subscription* currency**, not the currency the giver paid in. Resolve `giftPrice[recipientSubCurrency]` via the same per-currency resolver (T2.1 `currency_options`) and post it as a customer-balance transaction in that currency (Stripe balances are multi-currency; same-currency credit auto-applies to the next invoice before the card). **No live FX** — giver-paid and recipient-credited are two independent catalog anchors for the same gift SKU, and the small anchor spread is the same one already absorbed across the per-currency subscription model. Guaranteed to resolve by the `SUPPORTED_CURRENCIES == CURRENCIES` invariant; assert loudly in the N1 path if the recipient's sub currency is somehow absent.

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

**T5.2** Paid-sub overlap (D5), resolved **per axis**:
- Axis the recipient lacks → grant the term (as T5.1).
- Axis covered by a **single-axis or exact-tier** paid sub → **extend that subscription** by the gift term via the new extend mechanic (T5.4); do **not** credit.
- Single-axis gift fully inside a **Bundle** sub → `applyGiftAsCredit` the full gift amount **in the recipient's sub currency** (D10, catalog-denominated, no FX). This is the only surviving credit path.
- (Today `canCredit` diverts the *whole* gift to credit — replace with this per-axis extend/credit split.)

**T5.4** **Extend mechanic (net-new).** Add a helper to defer a live Stripe subscription by a gift term. Extends are **term-faithful** (a year is a year, regardless of the recipient's rate), so:
- monthly → **`pause_collection`** for the term (behavior `keep_as_draft`), then resume — *not* balance credit (crediting the gift's dollar value would over/under-deliver months since gift price ≠ 12× monthly rate).
- annual → push the renewal by editing the current period / `trial_end` so the **date visibly moves** out by the term (a bare pause skips a cycle but doesn't move the date).
- Credit (customer balance) is **not** an extend mechanic — it's reserved for the D5/D10 bundle-subset case only.
- Redemption (T5.2) calls this for extend-eligible axes.
- **Acceptance:** extending a monthly sub suppresses exactly `term` worth of charges and resumes normal billing after; extending an annual sub moves the renewal date out by exactly the term; no entitlement gap during the paused/shifted window.

**T5.3** Verify entitlement sync handles the `circle` and `ark_plus,circle` axes for gift-activated (non-subscription) memberships — SC feed for Ark+/Bundle, Circle provisioning for Community/Bundle, Beehiiv/newsletter axis.
- **Acceptance:** redeeming each tier as a new recipient activates the correct entitlements; cross-axis stacking (Ark+ gift + Community gift = both axes live with independent expiries) works; Bundle-on-Ark+ extends/credits ark_plus and grants circle.

## Phase 6 — Client

**T6.1** Add a **tier selector** to `src/components/GiftCheckoutModal.tsx` (Ark+ / Community / Bundle) alongside the existing term selector.

**T6.2** Thread `tier` through `src/lib/gift.ts` into the create-checkout call.

**T6.3** Show **per-currency** gift pricing in the modal (reuse the currency-detection/selector + per-currency display used by the subscription checkout).

**T6.4** Update `src/routes/plus/gift.tsx` copy/entry points for multi-tier gifting.
- **Acceptance:** user can pick tier + term, sees the price in their currency, and completes checkout.

## Phase 7 — Account settings & gift visibility ✅ DONE (commit 75b29a5)

Recipients are members with an expiry, not subscribers — account settings must show *what they have and until when* (per axis) and give a gift-safe path to the axis they lack.

- **D6 (RESOLVED)** — layout: **per-axis entitlement rows** (one row per axis: Ark+, Community), not a single plan card.
- **D7 (RESOLVED)** — missing-axis CTA sells the **standalone axis subscription** (Community-only / Ark+-only), reusing the existing per-currency `CheckoutModal`. Never offer Bundle while a live gift covers an axis (would double-pay the gifted axis).
- **D8 (RESOLVED)** — expiry conversion: in-app **banner + reminder email** via the existing reminder cron (`server/lib/feed-reminders.ts` / `feed-reminder-email.ts`, Resend).
- **D9 (RESOLVED, lightweight)** — no standalone feature. At gift expiry, if the recipient already holds the *other* axis via a live paid sub, the banner (T7.4) and email (T7.5) offer **switch-to-Bundle via change-tier** (in-branch, `server/routes/stripe/routes.ts`) instead of a standalone sub; otherwise the standard standalone CTA. (cancellation-flows is merged, so `retention.ts` / `cancellation.ts` / change-tier are all in-branch.)

**T7.1 ✅** `/api/me` returns per-axis `axes: { arkPlus, circle }` each `{ active, source: 'gift'|'subscription', expiresAt, renewsAt }` (`computeAxes` in `server/routes/me.ts`); threaded onto the client `Me` type.

**T7.2 ✅** Per-axis rows in `src/components/account/EntitlementAccess.tsx` (wired into `src/routes/account/index.tsx`) — each row shows access, source (🎁 Gift / Subscription), and the expiry/renewal date.

**T7.3 ✅** Missing-axis CTA opens the standalone-tier `CheckoutModal` (Ark+-only / Community-only); Bundle is never offered while a gift covers the other axis (standalone by construction, D7).

**T7.4 ✅** Near-expiry banner (≤14 days) for gifted axes. D9: offers **switch-to-Bundle via `changeTier`** when the other axis is a live sub, else a standalone renewal.

**T7.5 ✅** Gift-expiry reminder cron (`server/lib/gift-expiry-reminders.ts` + `gift-expiry-email.ts`, Resend): scans membership rows for gift axes ending ≤14 days out, resolves the recipient's email from Auth0 (membership stores no PII), one-time send per `(recipient, axis, term-end)` via ledger `gift_expiry_reminder_sends` (migration 0016, **applied**). Cron route `/api/cron/gift-expiry-reminders` (vercel.json, daily 16:00). 11 unit tests.
- **Acceptance ✅ (browser-verified):** a gifted-Ark+ member sees an Ark+ row (🎁 Gift, expiry) + a "Get Community" CTA opening the Community standalone checkout, and a near-expiry banner. The D9 bundle-mix case (Community gift + Ark+ sub) shows "Add it to your plan". Reminder email send path unit-tested.

## Phase 8 — Verification

**T8.1 ⏳ PENDING (needs live env).** Full gift purchase → redemption for one tier in a non-USD currency, confirming the `currency_options` charge. Requires Stripe **test mode** + a running `stripe listen` webhook forwarder + Auth0 (makes real test-mode charges) — not runnable headlessly. The redemption logic (extend-first, per-axis) is covered by 13 unit tests (`server/gift-redeem.test.ts`).

**T8.2 ⏳ PENDING (needs live env).** Confirm no regression to Ark+ gifting and subscription checkout (shared `pricing.ts` / catalog). Same live-env dependency as T8.1.

**Verified so far:** full production build passes; 750 server tests green (incl. 13 redemption + 11 reminder); account UI (T7.2–T7.4, incl. the D9 branch) browser-verified via Chrome DevTools against a mocked `/api/me`, console clean.

---

## Notes / risks

- **Per-currency is a fix, not just a feature:** gifts charge USD-only today because of the inert `adaptive_pricing`; Phases 2-3 are what actually enable per-currency.
- **Gift prices are independent** of subscription prices — don't derive gift amounts from subscription floors.
- **One-time vs recurring:** gift prices must be non-recurring; subscription (recurring) prices can't be reused in `mode: 'payment'`.
- Keep `scripts/stripe-catalog.ts` `CURRENCIES` and `pricing.ts` `SUPPORTED_CURRENCIES` in sync (existing invariant).
- **Extend mechanic is net-new (D5/T5.4):** pausing/period-shifting a live subscription is not in the redemption path today. A paused or period-shifted sub emits Stripe events — the webhook must **no-op these against entitlement changes** (the gift, not the sub state, owns the entitlement during the deferred window).
- **N1 credit on cancel (edge):** a full-gift credit to a Bundle holder sits on the Stripe customer balance and persists **unused** if they later cancel — it applies only against a future invoice. Acceptable (not a refund), but call it out in redemption/settings copy so it doesn't read as lost value.
- **Extend vs credit map to different Stripe mechanics (RESOLVED, T5.4/D10):** extends are term-faithful → `pause_collection` (monthly) / period-push (annual), *no* balance movement; credit is value-faithful and used only for the D5/D10 bundle-subset case → customer balance in the recipient's sub currency, auto-applied before the card. The two are not interchangeable.
