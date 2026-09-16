# Launch Tasks — Stripe Tax

Status: **code complete & verified in test mode.** The remaining items are all
Stripe Dashboard configuration in the **live** account before tax is collected
in production. No further code changes are required for these.

## What already shipped (code)
- `server/routes/stripe.ts` — subscription Checkout Session: `automatic_tax: { enabled: true }`,
  `customer_update: { address: 'auto' }`, and `tax_behavior: 'exclusive'` on the dynamic
  (name-your-price) Price.
- `server/routes/gift.ts` — gift (one-time) Checkout Session: same `automatic_tax` +
  `customer_update`, plus `tax_behavior: 'exclusive'` on the inline gift `price_data`.
- `src/components/CheckoutModal.tsx` + `GiftCheckoutModal.tsx` — `<BillingAddressElement />`,
  pre-tax headline, and a Subtotal / Discount / Tax / Total-due-today breakdown
  (tax row appears reactively once a billable address is entered).
- Tests: `server/checkout-create-session.test.ts`, `server/gift.test.ts` assert the new
  session args. Both green; `tsc` clean.

Architecture note: we use the **Checkout Sessions API** (`ui_mode: 'elements'` + `useCheckout`),
not a hand-rolled `subscriptions.create`. So `automatic_tax` on the *session* is what enables
tax on the subscription Checkout creates, and the `useCheckout` hook exposes the computed tax
on `checkout.total.taxExclusive` — no `invoices.createPreview` call is needed (despite the
Stripe onboarding email, which assumes a custom subscription flow).

Decision on record: **exclusive** tax behavior — displayed prices ($5.99 / $59.99) stay clean
and tax is added on top at checkout.

---

## LAUNCH TASK 1 — Activate Stripe Tax in the LIVE account
- [ ] Confirm Stripe Tax status is **active** in live mode (Dashboard → Settings → Tax).
      Test mode is already active; live is a separate toggle.
- [ ] Set the **origin / head office address** (test mode = US).
- [ ] Confirm an account-level **default tax behavior** or that all prices are exclusive (Task 3).

**Why:** with Tax inactive, `automatic_tax: { enabled: true }` errors at session creation and
checkout 500s. Verified in test mode that an active account creates sessions cleanly
(`automatic_tax.status: "complete"`).

## LAUNCH TASK 2 — Add tax registrations (live)
- [ ] Add a tax **registration** for every jurisdiction where Ark Media has nexus / is obligated
      to collect (Dashboard → Tax → Registrations). Consult finance/Taxually on where.
- [ ] After registering, the calculated tax flows into Tax Reports + the Taxually filing.

**Why:** Stripe Tax only calculates in jurisdictions where a registration exists. With **zero**
registrations it computes $0 everywhere (the current live state) and no Tax row ever renders.
Test-mode proof: a temporary NY registration made NY taxable; it was removed after verifying.

## LAUNCH TASK 3 — Set the product tax code(s)
- [ ] Assign the correct **Stripe tax code** to the Ark+ product(s) backing
      `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` and the gift product, so taxability matches
      what we actually sell (a digital audio membership — e.g. a streaming-audio / digital-services
      code, not the generic tangible-goods default).
- [ ] Re-verify a couple of jurisdictions after setting it (a US state with sales tax, an EU
      country) to confirm the rate Stripe applies is what's expected.

**Why (important finding):** with the **default** tax code, a NY address computed **$0**; with a
generic taxable code it computed **8.875% ($5.32 on $59.99)**. The tax code — not our integration —
determines where tax applies. $0 in many US states can be *correct* for a digital membership, but
this must be a deliberate classification, not an accident of the default.

## LAUNCH TASK 4 — Confirm price tax behavior in LIVE
- [ ] Verify `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` (live IDs) have
      `tax_behavior = exclusive` (or inherit it from an account default).

**Why:** a price with no tax behavior errors under automatic tax. The dynamic name-your-price and
gift prices set this in code; the two fixed Prices are Dashboard-configured. Both fixed test-mode
prices are already exclusive.

## LAUNCH TASK 5 — Live smoke test
- [ ] Real (or Stripe test-clock) checkout with a billing address in a **registered, taxable**
      jurisdiction → confirm the **Tax** row + recalculated **Total due today** render in the modal,
      and the resulting subscription/payment carries the tax in the Stripe Dashboard.
- [ ] Repeat for the **gift** flow (one-time payment mode).

**Why:** end-to-end confirmation that registration + tax code + exclusive price + the shipped UI
all line up in production. (Wiring already proven in test mode for both flows;
`automatic_tax.status: "complete"` on real sessions.)
