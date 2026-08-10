# Production Launch & User Migration Runbook

Status: **Draft — pre-launch.** Owner: engineering. Last updated: 2026-07-22.

This is the go-live checklist for Ark+ Insider. Two parts:

- **Part 1 — Accounts & API keys.** Every third-party account we depend on, the
  keys it produces, where each key goes, and what has to flip from test/sandbox
  to production.
- **Part 2 — Migrating ~15,000 existing members into Auth0** and emailing them
  how to log in.

> **Read first — the whole stack is still sandbox-scoped.** The app was built
> and tested against Stripe **test** keys, and `scripts/backfill-membership.ts`
> *refuses to run* unless `STRIPE_SECRET_KEY` starts with `sk_test_`
> (`assertTestMode`). Going to production is not just swapping keys — it means
> provisioning live catalogs/webhooks and lifting that guard for a controlled
> run. Every "flip to prod" step below is called out with ⚠️.

---

## Part 1 — Accounts & API keys

### 1.1 How configuration is wired

- **Local dev** reads `.env` / `.env.local` (Bun auto-loads them). `.env.example`
  is the canonical, commented list of every variable — treat it as the schema.
- **Production** reads Vercel Project → Settings → Environment Variables. Nothing
  server-side is committed; the browser only ever sees `VITE_`-prefixed values
  (embedded at build time by Vite).
- **Rule:** anything **not** prefixed `VITE_` is server-only and must never be
  exposed to the client. `VITE_`-prefixed values ship in the JS bundle — only
  publishable/DSN-class values belong there.
- **Cron auth:** Vercel Cron invokes the three jobs in `vercel.json`
  (`reconcile-entitlements` daily 03:00, `feed-setup-reminders` daily 15:00,
  `prune-webhook-events` monthly) with `Authorization: Bearer $CRON_SECRET`.

### 1.2 Accounts to own before launch

| # | Service | Why we need it | Plan / notes |
|---|---------|----------------|--------------|
| 1 | **Vercel** | Hosting, serverless API, cron, prod env store | Pro (cron + concurrency). |
| 2 | **Auth0** | Identity / login (BFF + social) | **Production tenant** on custom domain `auth.ark-plus.xyz`. Management API lives on the *native* tenant domain. |
| 3 | **Neon (Postgres)** | Source of truth for entitlement + app data | Prod project = `ark-insider-dev` (us-east-1) per current env. Confirm before launch. |
| 4 | **Stripe** | Payments, subscriptions, gift catalog | ⚠️ Live mode: catalog, webhooks, coupons all re-provisioned. |
| 5 | **Supporting Cast** | Legacy membership + private podcast feeds; **holds the ~15k members to migrate** | Real network id + API key. |
| 6 | **Simplecast** | Episode catalog (fetched at runtime — never hardcoded) | API token + per-show UUIDs. |
| 7 | **Resend** | Transactional email (gift welcome, feed reminders, **migration emails**) | Verified sending domain. |
| 8 | **Beehiiv** | Newsletter pages (Ark Daily + Members Letter) | API key, publication ids, premium tier id, webhook. |
| 9 | **Circle** | Community; gated Spaces via access group; SSO | Two tokens (v1 + v2), community id, access group id, SSO secret. |
| 10 | **PostHog** | Product analytics + session replay | Project key (`phc_…`). |
| 11 | **Sentry** | Error monitoring | Client DSN. |

### 1.3 Key-by-key checklist

Group headers below map to the sections in `.env.example`. "Prod source" = where
you get the value; "Scope" = server-only vs shipped to browser.

#### App / session
| Var | Scope | Prod source / action |
|---|---|---|
| `APP_BASE_URL` | server | Production origin, e.g. `https://arkmedia.org`. Drives magic-link/OAuth `redirect_uri` — must exactly match the deployed origin. |
| `SESSION_SECRET` | server | `openssl rand -hex 32`. **Set it** — if empty, a new one is generated each cold start and all sessions drop. |
| `CHECKOUT_SESSION_SECRET` | server | `openssl rand -hex 32`. Signs the short-lived post-checkout auto-login JWT. |
| `VITE_GATE_PASSWORD` | **browser** | Pre-launch password gate. **Leave empty in production at launch** to disable it (or keep set during a soft-launch window). |

#### Auth0
| Var | Scope | Prod source / action |
|---|---|---|
| `AUTH0_WEB_CLIENT_ID` / `AUTH0_WEB_CLIENT_SECRET` | server | Regular Web App (confidential) — the BFF login client. |
| `AUTH0_MANAGEMENT_CLIENT_ID` / `AUTH0_MANAGEMENT_CLIENT_SECRET` | server | M2M app ("Ark Plus M2M") authorized for the Management API. |
| `AUTH0_TENANT_DOMAIN` | server | **Native** tenant domain (e.g. `https://ark-media.us.auth0.com`) — Management API lives here, **not** on `auth.ark-plus.xyz`. |
| `AUTH0_LOGIN_CLIENT_ID` | server (optional) | Overrides the public login client used for `change_password` email; defaults to prod client in `server/auth0.ts`. |

**Auth0 tenant setup (one-time, dashboard — not env):**
1. Custom login domain `auth.ark-plus.xyz` verified; JWKS + ID-token issuer point here.
2. Database connection `Username-Password-Authentication` → **Disable Sign Ups = ON**
   (the Post-Login action only gates *social* connections).
3. Google social connection configured.
4. **Post-Login Action** deployed from `auth0/actions/post-login.js` (account
   linking + signup gate + claims). Its **Secrets**: `AUTH0_TENANT_DOMAIN`,
   `MGMT_CLIENT_ID`, `MGMT_CLIENT_SECRET`.
5. **M2M scopes** (Management API): `read:users`, `update:users`, `delete:users`,
   `read:roles`, `create:users`, `update:users_app_metadata`, and
   `create:user_tickets` (needed to mint set-password links). `update:users`
   (not just `update:users_app_metadata`) is required for identity linking.
6. Admin role assigned to the two admin accounts (ava@…, hannah.waxman8@…).
7. **Prod callback/allowed URLs** on the Web App include `APP_BASE_URL` +
   `/api/auth/callback` (and logout return URL).

#### Stripe ⚠️ (test → live)
| Var | Scope | Prod source / action |
|---|---|---|
| `STRIPE_SECRET_KEY` | server | Live secret `sk_live_…`. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | **browser** | Live publishable `pk_live_…`. |
| `STRIPE_WEBHOOK_SECRET` | server | `whsec_…` from the **live** webhook endpoint (below). |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY` | server | Live recurring Price ids (else server creates dynamic prices). |

**Stripe live setup:**
- Re-run the catalog provisioner (`scripts/stripe-catalog.ts`) against live mode
  to create products/prices with the `entitlements` metadata the tier resolver
  reads. Capture `SC_SUBSCRIPTION_PRICE_ID_*` and gift price ids too.
- Create the **live webhook endpoint** → `https://<APP_BASE_URL>/api/stripe/webhook`,
  subscribe to the subscription/invoice/checkout events the handler consumes,
  copy its signing secret into `STRIPE_WEBHOOK_SECRET`. The webhook is the source
  of truth for entitlement — verify it's reachable in prod (localhost is not in
  the delivery path).
- Disable Adaptive Pricing in the Dashboard (we use per-currency `currency_options`).
- Re-create coupons/promos in live mode (Stripe-native; auto-applied via metadata).

#### Supporting Cast
| Var | Scope | Prod source / action |
|---|---|---|
| `SC_NETWORK_ID` | server | Real network id. |
| `SC_API_KEY` | server | Admin Console → API Tokens (grants v1 **and** v2 access). |
| `SC_SUBSCRIPTION_PRICE_ID_MONTHLY` / `_YEARLY` / `_GIFT_6MO` / `_GIFT_1YR` | server | Admin Console → Subscription Plans → Prices. |
| `SC_WEBHOOK_SECRET` | server | `openssl rand -hex 32`; register SC webhook → `/api/sc/webhook?key=…` for `feed.activated` + `feed.access_revoked`. |

#### Simplecast
| Var | Scope | Prod source / action |
|---|---|---|
| `SIMPLECAST_API_TOKEN` | server | Account → Settings → API. Without it the API serves the mock catalog. |
| `VITE_SIMPLECAST_PODCAST_ID_*` (5 shows) | **browser** | Per-show UUIDs (Distribution → Embeds). |

#### Resend (email)
| Var | Scope | Prod source / action |
|---|---|---|
| `RESEND_API_KEY` | server | resend.com API key. If unset, sends are skipped (logged). **Required for the migration emails.** |
| `EMAIL_FROM` | server | A sender on the **verified** sending domain (SPF/DKIM set). |

#### Beehiiv
| Var | Scope | Prod source / action |
|---|---|---|
| `BEEHIIV_API_KEY` | server | Beehiiv API key. |
| `BEEHIIV_PUBLICATION_ID_ARK_DAILY` / `_MEMBERS_LETTER` | server | Publication ids (may be the same pub with audience tiers). |
| `BEEHIIV_PREMIUM_TIER_ID` | server | `GET /v2/publications/<id>/tiers`. |
| `BEEHIIV_WEBHOOK_SECRET` | server | `openssl rand -hex 32`; register `/api/beehiiv/webhook?key=…` for the subscription.* events. |

#### Circle
| Var | Scope | Prod source / action |
|---|---|---|
| `CIRCLE_API_TOKEN` | server | Admin **v1** token (member add/remove). |
| `CIRCLE_ADMIN_API_TOKEN` | server | Admin **v2** token (reads). Keep the two distinct — do not unify. |
| `CIRCLE_COMMUNITY_ID` | server | From any admin URL. |
| `CIRCLE_SUBSCRIBER_ACCESS_GROUP_ID` | server | Access group gating subscriber Spaces. |
| `CIRCLE_SSO_SECRET` | server | HS256 secret shared with Circle for SSO. Enforce SSO in Circle admin. |
| `CIRCLE_AUTH0_SUB_FIELD_KEY` | server | Circle member custom-field key used to match members by Auth0 sub. **Referenced in code but missing from `.env.example`** — add it. |

#### Database
| Var | Scope | Prod source / action |
|---|---|---|
| `DATABASE_URL` | server | Neon **pooled** connection string for the prod project. Run migrations via `.github/workflows/migrate.yml`; confirm all through `0015` applied (`bun run migrate:status`). |

#### Cron & observability
| Var | Scope | Prod source / action |
|---|---|---|
| `CRON_SECRET` | server | `openssl rand -hex 32`; Vercel sends it as `Authorization: Bearer` to cron routes. |
| `FEED_REMINDER_ENABLED` + `FEED_REMINDER_*` | server | Keep **off** until the activation backfill has run (see Part 2), or every migrated member gets a spurious nudge. |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | **browser** | PostHog project key + host (`us` or `eu`). Analytics funnel is dark in prod until the key is set. |
| `VITE_SENTRY_DSN` | **browser** | Sentry client DSN. |

### 1.4 Easily-missed prerequisites (accounts/verification, not just keys)
These have long lead times or external approval — start them early. None are a
matter of pasting a key.

| # | Prerequisite | Why it blocks launch | Owner |
|---|---|---|---|
| A | **Google OAuth production app** (Google Cloud Console) — OAuth 2.0 client id/secret wired into the Auth0 Google connection, **plus a verified OAuth consent screen** (app name, logo, authorized domains, privacy/terms URLs). | Auth0's built-in "dev keys" for Google are rate-limited, show Auth0 branding, and **must not** be used in production. Consent-screen verification by Google can take days. | Eng + brand |
| B | **Auth0 paid plan + "Production" tenant.** Custom domain (`auth.ark-plus.xyz`) and ~15k MAU both require a paid B2C plan; the tenant must be switched to the Production environment (stricter, but real, rate limits). | Free tier MAU cap is below 15k; custom domain won't run on free. Budget/procurement lead time. | Eng + finance |
| C | **Stripe account activation for live mode** — business identity, bank account, and payout details verified. | Live keys don't process payments until the account is activated; verification can bounce. | Finance |
| D | **DNS ownership & access** for `arkmedia.org` and `ark-plus.xyz` — Vercel domain, Auth0 custom-domain CNAME, and Resend SPF/DKIM/DMARC records all live here. | A single "who controls DNS" dependency gates the app domain, login domain, and email deliverability at once. | Eng |
| E | **Legal pages live** — Privacy Policy + Terms at stable URLs. | Required by the Google consent screen (A), by Stripe, and referenced in the migration email footer. | Legal |
| F | **Stripe Customer/Billing Portal + Tax config** (if used). Confirm the custom cancellation flow doesn't silently depend on the hosted portal. | A missing portal config surfaces as broken billing management post-launch. | Eng |

> **Note — SMS needs no separate provider.** `server/routes/sms.ts` sends
> setup-link texts by asking Supporting Cast to forward them to the carrier
> (SC bills per message). No Twilio/other account required; it rides on `SC_*`.

### 1.5 Secrets to generate (don't reuse dev values)
Regenerate all shared secrets for prod: `SESSION_SECRET`, `CHECKOUT_SESSION_SECRET`,
`CRON_SECRET`, `SC_WEBHOOK_SECRET`, `BEEHIIV_WEBHOOK_SECRET` — each
`openssl rand -hex 32`.

### 1.6 Pre-launch verification
- [ ] All server vars present in Vercel **Production** scope; `VITE_` vars also
      present at build time (they bake into the bundle).
- [ ] `bun run build` green; `bun test` green.
- [ ] Neon migrations through `0015` applied to prod.
- [ ] Stripe live webhook shows a successful test delivery; a real test purchase
      provisions Auth0 user + Neon `membership` + Circle access.
- [ ] Auth0 prod login round-trips (email/password **and** Google, incl. the
      account-linking path).
- [ ] Cron routes return 200 only with the correct `CRON_SECRET`.
- [ ] Resend domain verified; a test send lands (not spam).
- [ ] `VITE_GATE_PASSWORD` decision made (empty = public).

---

## Part 2 — Migrating ~15,000 existing members into Auth0

### 2.1 The situation
The ~15k existing members live in **Supporting Cast** (legacy membership +
private feeds). They have no login on the new site. We need to, for each entitled
member:

1. Create an Auth0 account on the `Username-Password-Authentication` connection.
2. Write a `membership` row in Neon (the entitlement source of truth) so gates
   resolve the correct tier.
3. Email them a branded "set your password / log in" message.

**Why this shape works with the existing code:** the app already treats "a
Database account exists for this email" as "this is a real member" — the
Post-Login signup gate (`auth0/actions/post-login.js`) rejects anyone *without*
one. So bulk-creating the accounts is exactly what turns 15k SC members into 15k
people who can log in. Google-first login then links onto the Database account
automatically, **provided the Google email matches the SC email**.

### 2.2 Why not just loop `findOrCreateAuth0User` 15,000 times
That path calls Auth0's `dbconnections/change_password` **per user**, which is
tightly rate-limited and would blast 15k emails on Auth0's timing, not ours. It's
right for one-off checkout/gift provisioning, wrong for a bulk backfill. For the
migration we use Auth0's **Bulk User Import job** to create accounts, then send
**our own** Resend email carrying a per-user set-password link. This gives us
batching, branded copy, retries, and send-rate control.

### 2.3 The ⚠️ blocker to clear first
`scripts/backfill-membership.ts` hard-refuses any non-`sk_test_` key
(`assertTestMode`) because the whole redesign was sandbox-scoped. Before a
production entitlement backfill you must consciously lift that guard (a
`--prod`/`--i-understand` flag, not deleting the check) and re-verify the script
against a Neon **branch** first. Do not remove the guard silently.

### 2.4 Data flow

```
Supporting Cast roster (~15k)
        │  export: email, first/last name, sc_user_id, plan, status
        ▼
[1] Build import file (dedup, validate emails, entitled-only)
        │
        ├──► [2] Auth0 Bulk Import job ──► Database accounts (email_verified:false)
        │                                   password left unset (temp)
        │
        └──► [3] Neon `membership` upsert (tier from plan) ── source of truth
        │
        ▼
[4] Per-user set-password ticket (Management API, create:user_tickets)
        ▼
[5] Resend branded "Welcome to the new Ark+ — set your password" email
        ▼
[6] Reconcile: activation backfill, then enable feed reminders
```

### 2.5 Step-by-step

**[1] Export & prepare the roster.**
- **Export the roster from Supporting Cast as a CSV** (confirmed source). Required
  columns: `email`, `first_name`, `last_name`, `sc_user_id`, `plan`, `status`.
  Keep this CSV as the immutable **system-of-record snapshot** of who was migrated
  and when — do not overwrite it mid-run.
  - (The reminder cron reads the live roster via v1 `loadAllMemberships`; for a
    one-shot migration a CSV is simpler and gives you a frozen, auditable input.)
- Filter to **entitled** members (active/comped/gift). Drop cancelled/expired
  unless product wants a win-back path.
- **Normalize + dedup on lowercased email** — email is the join key for the whole
  system. Discard invalid/blank emails to a manual-review list.
- Output a JSON array shaped for Auth0 import (see [2]) plus a parallel CSV for
  the Neon backfill (email + sc_user_id + tier).

**[2] Bulk-create Auth0 accounts.**
- Use Management API **Create Import Users Job** (`POST /api/v2/jobs/users-imports`)
  against `Username-Password-Authentication`. One record per member:
  ```json
  { "email": "member@example.com", "email_verified": false,
    "given_name": "Ada", "family_name": "Lovelace" }
  ```
  - Omit passwords → accounts exist with no usable password; members set one via
    the link in [4]. Matches how `findOrCreateAuth0User` already leaves accounts.
  - `email_verified:false` is fine — the Post-Login gate keys on *existence* of
    the Database account, not its verified flag (see the action's notes). The
    set-password ticket in [4] marks the email verified when they complete it.
  - `upsert:false`, `send_completion_email:false`. Chunk into files of a few
    thousand; Auth0 processes one import job at a time — submit sequentially and
    poll job status. Log per-record failures for manual retry.

**[3] Backfill Neon `membership` (entitlement source of truth).**
- Adapt `scripts/backfill-membership.ts` — it already resolves `auth0_sub` by
  email (`auth0SubForEmail`) and upserts idempotently. Its **Pass B** (SC members
  without a Stripe sub) is exactly the migration cohort; they're written as
  `ark-plus`, perpetual (null expiry).
  - Map SC plan → tier deliberately (don't blanket-`ark-plus` if bundle/circle
    tiers exist for these members).
  - ⚠️ Clear the test-mode guard (2.3) and dry-run (no `--apply`) against a Neon
    branch; diff the row count against the roster before `--apply` on prod.
- Idempotent by `auth0_sub` — safe to re-run for stragglers.

**[4] Mint per-user set-password links.**
- For each created user, call `createAuth0PasswordChangeTicket(userId, resultUrl, env)`
  (`server/lib/auth0-user.ts`) — a self-contained URL, `mark_email_as_verified:true`,
  `result_url` = a post-set landing page (e.g. `${APP_BASE_URL}/welcome`).
  - Requires M2M `create:user_tickets`.
  - **Throttle** — the Management API is rate-limited; run at a steady rate
    (e.g. batches with backoff) over hours, not all at once. Tickets are
    long-lived enough to pre-mint per batch right before the send.
  - Persist `{email, userId, ticketUrl, sent:false}` so the send is resumable and
    idempotent.

**[5] Send the login-instructions email via Resend.**
- One branded email per member, `from = EMAIL_FROM`, containing the set-password
  link from [4]. Suggested copy skeleton:
  > **Subject:** Your Ark+ membership has a new home — set your password
  >
  > Hi {first_name}, we've moved Ark+ to a new website. Your membership and
  > private feeds carried over. To finish, set your password and sign in:
  > **[Set my password]({ticketUrl})**. Prefer Google? You can sign in with the
  > Google account on **{email}** and we'll link it automatically.
  > Questions? Reply to this email.
- **Rate-limit sends** to Resend's account throughput; mark `sent:true` per
  record so a re-run only targets the unsent. Send in waves (e.g. 1–2k/hr) so
  support can absorb replies and you can watch deliverability.
- **Deliverability:** warm the domain, verify SPF/DKIM/DMARC, and consider a
  first small canary batch (e.g. 200 internal/friendly addresses) before the
  full 15k.

**[6] Reconcile & enable ongoing jobs.**
- Run the **feed-activation backfill** (`scripts/backfill-feed-activations-from-csv.ts`
  / `feed-activation-csv`) so migrated members who already activated feeds aren't
  treated as un-started — **then** set `FEED_REMINDER_ENABLED`. Order matters:
  enabling reminders first spams already-set-up members.
- The nightly `reconcile-entitlements` cron will keep Neon aligned with
  Stripe/SC afterward.

### 2.6 Email compliance & deliverability (the 15k blast)
Sending 15,000 emails in a short window is the highest-risk, least-reversible step.
- **Classification.** A one-time "your account moved, set your password" notice is
  defensible as **transactional**, but treat it with marketing-grade care: include
  a physical mailing address and an unsubscribe/contact path (CAN-SPAM), and honor
  any prior opt-outs.
- **Auth / reputation.** SPF, DKIM, **and DMARC** aligned on the `EMAIL_FROM`
  domain before the first send. Decide dedicated vs shared IP with Resend; if
  dedicated, **warm it** — you cannot cold-send 15k from a fresh IP without
  landing in spam.
- **Waves + canary.** Send a small internal canary (~200) first, check
  placement/bounces, then ramp in waves (e.g. 1–2k/hr) so support and
  deliverability signals stay observable.
- **Suppression.** Track Resend bounces/complaints and never re-send to them; a
  hard bounce = a member with no way in (route to manual outreach).

### 2.7 Rehearse before prod (staging Auth0 + Neon branch)
- Do a full dry run of import → backfill → ticket-mint against a **separate dev
  Auth0 tenant** and a **Neon branch**, using a slice of the CSV (a few hundred
  rows). Bulk-import mistakes are painful to unwind on a prod tenant.
- **Back up first:** snapshot the prod Neon DB before the entitlement backfill,
  and keep the SC CSV frozen (2.5[1]). Rollback = restore Neon + (if needed)
  delete the imported Auth0 batch by run tag.
- Budget the **Auth0 Management API rate limit** for minting ~15k set-password
  tickets — this, not account creation, is the throughput bottleneck. Import jobs
  are serialized (one at a time); ticket minting is per-call. Plan the run over
  hours, resumable at each step.

### 2.8 Known edge cases (document for support)
- **Email mismatch on Google sign-in.** A member whose Google email ≠ their SC
  email has no matching Database account and is rejected as a stranger. Support
  fix: have them use the password link, or align the email. This is inherent to
  email-as-join-key.
- **Duplicate emails / pre-existing accounts.** Import with `upsert:false` and
  reconcile the skip list — staff/admin/comp accounts may already exist from dev.
- **Bounced migration emails.** Track Resend bounces; a bounced address = no way
  in. Route to a manual list.
- **Members who log in before the email.** Fine for password path (they can't
  without the link) but a Google-first login works immediately if the account
  exists and the email matches — which is the desired outcome.
- **Rate limits.** Both Auth0 (import jobs are serialized; Management API ticket
  minting) and Resend (send throughput) are the real constraints. Plan the run
  over a day, resumable at every step.

### 2.9 Rollout order (summary)
1. Prod accounts + keys live (Part 1), Stripe live webhook verified.
2. Neon migrations applied; **dry-run** the entitlement backfill on a branch.
3. Bulk import a **canary** cohort (~100), verify login + entitlement end-to-end.
4. Full Auth0 import → Neon backfill → mint tickets.
5. Canary email batch → then waved full send.
6. Feed-activation backfill → enable feed reminders.
7. Monitor: Sentry errors, Auth0 login success rate, Resend deliverability,
   support inbox.

---

## Open questions for product/ops
- Which SC plans map to which tier (`ark-plus` vs `bundle`/`circle`)?
- Do cancelled/expired SC members get a migration email (win-back) or not?
- Launch with the `VITE_GATE_PASSWORD` gate on (soft launch) or fully public?
- Send-window and support staffing for the 15k email wave.
- **Email ownership — Supporting Cast vs Resend.** Do we keep letting Supporting
  Cast send member emails (feed-setup links, receipts, its own new-content
  notices), or consolidate **all** member-facing email onto Resend for one
  branded sender, one deliverability reputation, and one suppression list?
  Trade-offs: SC-sent mail is zero-effort but off-brand, split across two sending
  domains/reputations, and outside our unsubscribe/analytics; owning it on Resend
  gives brand + control but means re-implementing whatever SC sends today (and we
  already own new-episode/new-post notices via the self-built 6h cron, so the
  split is real). Decide before the migration blast so the "set your password"
  email and any SC-sent welcome don't collide or double-send.
