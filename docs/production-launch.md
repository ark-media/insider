# Production Launch Runbook

Status: **Draft — pre-launch.** Owner: engineering. Last updated: 2026-07-22.

This is the go-live checklist for Ark+ Insider: every third-party account we
depend on, the keys it produces, where each key goes, and what has to flip from
test/sandbox to production.

> **Read first — the whole stack is still sandbox-scoped.** The app was built
> and tested against Stripe **test** keys, and `scripts/stripe-catalog.ts`
> *refuses to run* unless `STRIPE_SECRET_KEY` starts with `sk_test_`
> (`assertTestMode`). Going to production is not just swapping keys — it means
> provisioning live catalogs/webhooks, and the catalog script needs a reviewed
> change before it will touch live (see Stripe live setup). Every "flip to
> prod" step below is called out with ⚠️.

> **BLOCKER — the live site has no database of its own.** `ark-plus.xyz`,
> staging, local dev and the ungated merge-to-main migrations all use
> `ark-insider-dev`; `ark-insider-prod` is wired to GitHub only. Do not take
> real members until this is done, in this order:
> 1. Vercel → arkmedia → Environment Variables: give **Production** its own
>    `DATABASE_URL`, the **pooled** `ark-insider-prod` string (Preview keeps
>    `ark-insider-dev`).
> 2. Bring the prod schema current: run "Migrate database" from the
>    `production` branch (approval-gated) and check `migrate:status` shows every
>    file in `migrations/` applied.
> 3. Only then flip Settings → Git → Production Branch to `production`
>    (`docs/deploys.md`).
>
> Until step 1, put a required reviewer on the `preview` GitHub Environment: a
> merge to main migrates the database the live site reads.

---

## Accounts & API keys

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
| 5 | **Resend** | Transactional email (gift welcome, feed reminders, **migration emails**) | Verified sending domain. |
| 6 | **Beehiiv** | Newsletters (Ark Daily + Members Letter), episode catalog (fetched at runtime — never hardcoded), and the private paid feed | API key, publication ids, podcast ids, premium tier id, webhook. |
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

**Auth0 tenant setup (one-time, dashboard — not env):**
1. Custom login domain `auth.ark-plus.xyz` verified; JWKS + ID-token issuer point here.
2. Database connection `Username-Password-Authentication` → **Disable Sign Ups = ON**
   (the Post-Login action gates the social and passwordless connections).
   The connection still backs every member's canonical account — it is just no
   longer offered as a way to *sign in*. See `auth0/README.md`.
2b. **Authentication Profile = Identifier First**, Passwordless → Email enabled
   with **Verification Method = OTP**, and its **Disable Sign Ups = ON** (the
   same as the database connection). Auth0 then mails a code only to an address
   that already holds an `email` identity, and we create that identity at
   provisioning time (`linkEmailCodeLogin`). Anyone provisioned outside that
   path — a bulk CSV import, or a hand-made dashboard account — needs
   `scripts/backfill-email-code-login.ts` or they cannot receive a code at all.
   `auth0/README.md` has the detail, including why the failure looks exactly
   like an email-delivery problem and isn't one.
2c. **Enable the passwordless connection per application.** On for the website
   (ArkPlus). For Circle's Custom SSO application decide deliberately: with it
   off, the code option is not drawn on the Fold's login page, which matters for
   any cohort provisioned without a password.
3. Google social connection configured.
4. **Post-Login Action** deployed from `auth0/actions/post-login.js` (account
   linking + signup gate + claims). Its **Secrets**: `AUTH0_TENANT_DOMAIN`,
   `MGMT_CLIENT_ID`, `MGMT_CLIENT_SECRET`.
5. **M2M scopes** (Management API): `read:users`, `update:users`, `delete:users`,
   `read:roles`, `create:users`, and `update:users_app_metadata`. `update:users`
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
  reads. Capture the gift price ids too. ⚠️ The script **hard-refuses any key
  that is not `sk_test_`** (`assertTestMode`), and that is deliberate: it
  creates and archives prices. Going live needs a reviewed PR that adds an
  explicit live path (e.g. a `--live` flag that prints the account and asks for
  confirmation), merged ahead of time — not the guard deleted on launch day.
- Create the **live webhook endpoint** → `https://<APP_BASE_URL>/api/stripe/webhook`,
  subscribe to the subscription/invoice/checkout events the handler consumes,
  copy its signing secret into `STRIPE_WEBHOOK_SECRET`. The webhook is the source
  of truth for entitlement — verify it's reachable in prod (localhost is not in
  the delivery path).
- Disable Adaptive Pricing in the Dashboard (we use per-currency `currency_options`).
- Re-create coupons/promos in live mode (Stripe-native; auto-applied via metadata).

#### Resend (email)
| Var | Scope | Prod source / action |
|---|---|---|
| `RESEND_API_KEY` | server | resend.com API key. If unset, sends are skipped (logged). **Required for the migration emails.** |
| `EMAIL_FROM` | server | A sender on the **verified** sending domain (SPF/DKIM set). |

#### Beehiiv
| Var | Scope | Prod source / action |
|---|---|---|
| `BEEHIIV_API_KEY` | server | Beehiiv API key. Also the podcast catalog's credential. |
| `BEEHIIV_PUBLICATION_ID_ARK_DAILY` / `_MEMBERS_LETTER` | server | Publication ids (may be the same pub with audience tiers). |
| `BEEHIIV_PREMIUM_TIER_ID` | server | `GET /v2/publications/<id>/tiers`. |
| `BEEHIIV_WEBHOOK_SECRET` | server | `openssl rand -hex 32`; register `/api/beehiiv/webhook?key=…` for the subscription.* events. |

##### Podcasts
Every episode on the site is fetched from Beehiiv at runtime — there is no local
catalog and no fallback. A show whose id is missing renders "No episodes yet"
and logs nothing, so **check each show's page after deploy** rather than trusting
a green build.

| Var | Scope | Prod source / action |
|---|---|---|
| `BEEHIIV_PUBLICATION_ID_PODCASTS` | server | Publication the podcasts live under. Falls back to `BEEHIIV_PUBLICATION_ID_ARK_DAILY` if unset — set it explicitly if the shows sit in their own publication. |
| `BEEHIIV_PODCAST_ID_<SLUG>` (4 shows) | server | One per show, slug upper-cased with `-`→`_`: `_CALL_ME_BACK`, `_FOR_HEAVENS_SAKE`, `_ARK_NEWS_DAILY`, `_CHOSEN_PEOPLE_PROBLEMS`. Beehiiv's own `pod_…` id; the bare UUID is accepted and normalised. |

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
| `DATABASE_URL` | server | Neon **pooled** connection string for the prod project (`ark-insider-prod` — see the BLOCKER at the top). Run migrations via `.github/workflows/migrate.yml`; confirm every file in `migrations/` is applied (`bun run migrate:status`) — the history was squashed, so that is `0001_initial_schema` plus whatever follows it, not "through `0015`". |

#### Cron & observability
| Var | Scope | Prod source / action |
|---|---|---|
| `CRON_SECRET` | server | `openssl rand -hex 32`; Vercel sends it as `Authorization: Bearer` to cron routes. |
| `FEED_REMINDER_ENABLED` + `FEED_REMINDER_*` | server | Keep **off** until real members exist and their feed-activation state is being recorded, or the first run nudges people who are already set up. |
| `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` | **browser** | PostHog project key + host (`us` or `eu`). Analytics funnel is dark in prod until the key is set. |
| `VITE_SENTRY_DSN` | **browser** | Sentry client DSN. |

### 1.4 Easily-missed prerequisites (accounts/verification, not just keys)
These have long lead times or external approval — start them early. None are a
matter of pasting a key.

| # | Prerequisite | Why it blocks launch | Owner |
|---|---|---|---|
| A | **Google OAuth production app** (Google Cloud Console) — OAuth 2.0 client id/secret wired into the Auth0 Google connection, **plus a verified OAuth consent screen** (app name, logo, authorized domains, privacy/terms URLs). | Auth0's built-in "dev keys" for Google are rate-limited, show Auth0 branding, and **must not** be used in production. Consent-screen verification by Google can take days. | Eng + brand |
| B | **Auth0 paid plan + "Production" tenant.** The custom domain (`auth.ark-plus.xyz`) requires a paid B2C plan, and the tenant must be switched to the Production environment (stricter, but real, rate limits). | Custom domain won't run on free, and the free MAU cap needs checking against projected signups. Budget/procurement lead time. | Eng + finance |
| C | **Stripe account activation for live mode** — business identity, bank account, and payout details verified. | Live keys don't process payments until the account is activated; verification can bounce. | Finance |
| D | **DNS ownership & access** for `arkmedia.org` and `ark-plus.xyz` — Vercel domain, Auth0 custom-domain CNAME, and Resend SPF/DKIM/DMARC records all live here. | A single "who controls DNS" dependency gates the app domain, login domain, and email deliverability at once. | Eng |
| E | **Legal pages live** — Privacy Policy + Terms at stable URLs. | Required by the Google consent screen (A), by Stripe, and referenced in the migration email footer. | Legal |
| F | **Stripe Customer/Billing Portal + Tax config** (if used). Confirm the custom cancellation flow doesn't silently depend on the hosted portal. | A missing portal config surfaces as broken billing management post-launch. | Eng |

> **Note — no SMS provider needed.** Setup links are delivered by email
> (`POST /api/me/feeds/email` asks Beehiiv to send the member their feed), so
> there is no Twilio or carrier dependency to provision.

### 1.5 Secrets to generate (don't reuse dev values)
Regenerate all shared secrets for prod: `SESSION_SECRET`, `CHECKOUT_SESSION_SECRET`,
`CRON_SECRET`, `BEEHIIV_WEBHOOK_SECRET` — each
`openssl rand -hex 32`.

### 1.6 Pre-launch verification
- [ ] All server vars present in Vercel **Production** scope; `VITE_` vars also
      present at build time (they bake into the bundle).
- [ ] `bun run build` green; `bun test` green.
- [ ] Every file in `migrations/` applied to prod (`0001_initial_schema`,
      `0002_faq_drop_password_signin`, then `0003`–`0005`; `migrate:status`
      shows no `pending`).
- [ ] Stripe live webhook shows a successful test delivery; a real test purchase
      provisions Auth0 user + Neon `membership` + Circle access.
- [ ] Auth0 prod login round-trips (**emailed one-time code** and Google, incl.
      the account-linking path). There is no password option: confirm the login
      page offers exactly those two.
- [ ] Cron routes return 200 only with the correct `CRON_SECRET`.
- [ ] Resend domain verified; a test send lands (not spam).
- [ ] `VITE_GATE_PASSWORD` decision made (empty = public).

### 1.7 Security checklist
- [ ] **BLOCKER:** Vercel Production has its own `ark-insider-prod`
      `DATABASE_URL`, prod schema is current, Production Branch flipped (top of
      this doc).
- [ ] **Migrations `0003`–`0005` applied** (rate-limit buckets, webhook ledger
      lease, admin audit log). The code tolerates
      their absence, so deploy order doesn't matter — but until they are
      applied those protections are simply off.
- [ ] **Least-privilege runtime DB role.** Vercel's pooled `DATABASE_URL` uses
      `app_rw`; the owner role stays only in the migrate workflow's direct URL.
      As the owner, on `ark-insider-prod`:
      ```sql
      create role app_rw login password '<openssl rand -hex 24>';
      grant connect on database neondb to app_rw;
      grant usage on schema public to app_rw;
      grant select, insert, update, delete on all tables in schema public to app_rw;
      grant usage, select on all sequences in schema public to app_rw;
      alter default privileges in schema public
        grant select, insert, update, delete on tables to app_rw;
      alter default privileges in schema public
        grant usage, select on sequences to app_rw;
      revoke all on table _migrations from app_rw;
      ```
      (Swap `neondb` for the real database name. Run the default-privileges
      lines as the role that runs migrations, so new tables are covered.)
- [ ] **Enforce the CSP.** `vercel.json` ships it as
      `Content-Security-Policy-Report-Only`. After a week of clean reports at
      `/api/csp-report`, rename the header to `Content-Security-Policy`. First
      confirm the `media-src` hosts cover where Beehiiv actually serves podcast
      audio (play an episode of each show, free and paid, and watch for
      redirects to a CDN host).
- [ ] **GitHub:** Actions are SHA-pinned (done, Dependabot bumps them); branch
      and environment protection per "Required GitHub settings" in
      `docs/deploys.md`.
- [ ] **Auth0 prod tenant:** Disable Sign Ups still ON for both the Database
      and the passwordless `email` connection; the prod M2M client holds only
      the scopes in step 5 above, nothing broader.
- [ ] **Beehiiv:** double opt-in on for both publications.
- [ ] **Beehiiv webhook key rotated at launch** (`BEEHIIV_WEBHOOK_SECRET`; it
      travels in the registered URL's `?key=`, so re-register the webhook with
      the new value).
- [ ] **`VITE_GATE_PASSWORD` is not access control.** It ships in the JS bundle
      and the API behind it is ungated. For a soft launch use Vercel Deployment
      Protection instead; at launch leave the variable empty.
- [ ] **PostHog:** the project's session-replay masking settings match the code
      (`src/lib/observability.ts`: `mask_all_text`, `maskAllInputs`) — the
      dashboard can override what the SDK asks for.

---


---

## Open questions for product/ops
- Launch with the `VITE_GATE_PASSWORD` gate on (soft launch) or fully public?
- **Email ownership — Beehiiv vs Resend.** Beehiiv sends the feed-delivery mail
  (`POST /api/me/feeds/email`) and the newsletters; Resend sends our own
  transactional mail. Confirm the split is deliberate before any launch blast, so
  our welcome email and Beehiiv's own feed mail don't collide or double-send.
