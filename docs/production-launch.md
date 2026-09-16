# Production Launch Runbook

Status: **Draft — pre-launch.** Owner: engineering. Last updated: 2026-07-22.

This is the go-live checklist for Ark+ Insider: every third-party account we
depend on, the keys it produces, where each key goes, and what has to flip from
test/sandbox to production.

> **Read first — the whole stack is still sandbox-scoped.** The app was built
> and tested against Stripe **test** keys, and `scripts/backfill-membership.ts`
> *refuses to run* unless `STRIPE_SECRET_KEY` starts with `sk_test_`
> (`assertTestMode`). Going to production is not just swapping keys — it means
> provisioning live catalogs/webhooks and lifting that guard for a controlled
> run. Every "flip to prod" step below is called out with ⚠️.

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
  reads. Capture the gift price ids too.
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
| `DATABASE_URL` | server | Neon **pooled** connection string for the prod project. Run migrations via `.github/workflows/migrate.yml`; confirm all through `0015` applied (`bun run migrate:status`). |

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
- [ ] Neon migrations through `0015` applied to prod.
- [ ] Stripe live webhook shows a successful test delivery; a real test purchase
      provisions Auth0 user + Neon `membership` + Circle access.
- [ ] Auth0 prod login round-trips (email/password **and** Google, incl. the
      account-linking path).
- [ ] Cron routes return 200 only with the correct `CRON_SECRET`.
- [ ] Resend domain verified; a test send lands (not spam).
- [ ] `VITE_GATE_PASSWORD` decision made (empty = public).

---


---

## Open questions for product/ops
- Launch with the `VITE_GATE_PASSWORD` gate on (soft launch) or fully public?
- **Email ownership — Beehiiv vs Resend.** Beehiiv sends the feed-delivery mail
  (`POST /api/me/feeds/email`) and the newsletters; Resend sends our own
  transactional mail. Confirm the split is deliberate before any launch blast, so
  the "set your password" email and Beehiiv's own feed mail don't collide or
  double-send.
