# Entitlement redesign — cutover runbook

Operational checklist for shipping the Ark+/Circle/Bundle redesign
(`tasks/entitlement-tiers.md`). Scope: **Stripe sandbox / test mode only.** Do
each step in order — several are order-sensitive.

## Pre-deploy (data)

1. **Run the membership backfill before the tasks-10/11 cutover** (§9, risk 3):
   ```
   bun run scripts/backfill-membership.ts --apply
   ```
   Neon is the single authority once `/api/me` and the gates read it, so every
   existing paid member (and gift/comp/staff row) must have a membership row
   first — otherwise they read `free`. Verify the row count matches active subs +
   gifts before deploying the reader changes. Only after this is verified may the
   task-10 transitional SC-by-email fallback be removed.

2. **Migration `0010_membership.sql`** is applied (`bun run migrate`).

## Release window (order-sensitive)

3. **Task 16 — Circle admin cutover.** In Circle admin, **turn off Circle's own
   paid membership** so invited members join free (we bill via Stripe). Pin this
   to the **same release** that starts selling Circle (task 8/13):
   - Too early → invited members join free with no Stripe record.
   - Too late → members can double-pay (Circle's paywall + ours).
   Set `CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID` and (if the custom field isn't keyed
   `auth0_sub`) `CIRCLE_AUTH0_SUB_FIELD_KEY` in the environment first.

4. **Disable Adaptive Pricing in the Stripe Dashboard** once the launch
   currencies are enumerated (§7 #4). `currency_options` (per-currency floors) and
   Adaptive Pricing are mutually exclusive; leaving a mix reopens the floorless-
   switch hole for the Adaptive currencies.

5. **Tasks 10 + 12 deploy atomically** (the one unavoidable atomic pair): the new
   `/api/me` shape and the client that reads `entitlements` must ship together, or
   every paying member bounces to `/plus` for one release (risk 4).

## Post-deploy — empirical verifications (cannot be checked from code)

These were implemented against the documented/assumed API shapes and are flagged
in the code as VERIFY-PENDING. Confirm each against the live test-mode systems:

6. **Circle email-linking + custom-field round-trip** (§7 #9, gates the
   reconciler's Circle axis):
   - A member pre-created by email, then SSO'd with that same email, **links** to
     the existing record (no duplicate).
   - The stamped `auth0_sub` custom profile field comes back on the access-group
     roster (`readCircleProfileField` in `server/entitlement.ts` tries
     `profile_fields` / `custom_fields` / `fields[]` — confirm which one is real).

7. **Billing portal render** (§7 #7): once a test sub exists, wire the Stripe
   Customer Portal and confirm it renders. **Configure it with
   `subscription_update` DISABLED** (§1a) — tier changes go through the in-app
   `/api/stripe/change-tier` flow, never the portal (the portal carries `quantity`
   across a product switch and would mis-charge).

8. **`currency_options` ↔ Adaptive Pricing** (§7 #4): probe that Checkout with an
   explicit `currency` + `currency_options` price charges the right floor with
   Adaptive disabled, and that the CurrencySelectorElement still lists the
   supported currencies.

9. **Tier-switch mechanics** (§6, `POST /api/stripe/change-tier`): against a live
   test-mode sub, confirm the immediate path (gain entitlement / PWYC raise /
   monthly→yearly) prorates in place and the period-end path (lose entitlement /
   PWYC lower) schedules correctly and releases cleanly. Then confirm Cancel /
   Reactivate / retention no longer 500 on a schedule-managed sub (risk 7).

## Independent

10. **Task 18 — rotate leaked secrets.** `CIRCLE_API_TOKEN`,
    `CIRCLE_ADMIN_API_TOKEN`, `CIRCLE_SSO_SECRET`, `BEEHIIV_API_KEY` are committed
    in `.env.example`. Rotate at source, commit placeholders. Not blocking, but do
    before any public launch.

## Reconciler

The nightly reconciler (`reconcileEntitlements`) is Neon-authoritative and
removal-only. Do **not** enable the cron until step 6 confirms the Circle
custom-field projection, and until step 1's backfill is verified complete — an
incomplete backfill would let the SC drift pass delete still-paid feeds (capped
by `SC_DRIFT_MAX_REMOVE`, but still). It heals grants nowhere; grants flow
through the webhook.
