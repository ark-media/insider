# Website security review

Date: 2026-09-27

Scope: the React/Vite client, Vercel serverless API, authentication/session code, payment and webhook routes, deployment headers, and dependency metadata in this repository.

## Executive summary

The application has several strong controls already in place: HttpOnly/Secure session cookies, strict SameSite cookies outside local development, PKCE/state/nonce checks for Auth0, explicit admin authorization, same-origin checks on authenticated mutations, parameterized SQL, bounded request bodies, rate limiting, allowlisted HTML sanitization, Stripe webhook verification, and extensive security-focused tests.

The requested remediation pass addressed the browser security policy and gift-claim storage issue, and added header-based webhook authentication support. The temporary preview gate remains unchanged by request:

1. The preview password is a client-side feature flag, not access control. Anyone can read it from the JavaScript bundle and the API is not gated. This remains intentionally unchanged.
2. The CSP was changed to an enforcing `Content-Security-Policy` header.
3. The gift claim bearer token is now exchanged for a short-lived HttpOnly cookie instead of being persisted in `sessionStorage`.

The Beehiiv webhook now prefers a dedicated secret header and rejects a wrong header even when a query secret is present. The existing query-string fallback remains only for the current Beehiiv configuration, because the repository documents that Beehiiv does not offer custom webhook headers. Eliminating that residual exposure requires moving the provider or an intermediary to the header mode.

## Findings

### SEC-001 — Preview password is exposed in the client bundle and does not protect the API

Severity: Medium (conditional on using the gate to protect non-public preview data)

Location: [src/Gate.tsx:3-4](/Users/hannahwaxman/Documents/ark-media/insider/src/Gate.tsx:3), [src/Gate.tsx:59-61](/Users/hannahwaxman/Documents/ark-media/insider/src/Gate.tsx:59), [src/main.tsx:31-39](/Users/hannahwaxman/Documents/ark-media/insider/src/main.tsx:31), and [docs/production-launch.md:277-279](/Users/hannahwaxman/Documents/ark-media/insider/docs/production-launch.md:277)

Evidence: `VITE_GATE_PASSWORD` is compiled into the browser bundle, compared locally, and stored in `sessionStorage`. The gate only wraps the React router; the server API has no corresponding authorization boundary.

Impact: Anyone who can load the preview can inspect the bundle, recover the password, or call the API directly. This can expose preview content or operational functionality if the preview deployment contains data that is not intended to be public. The repository's launch documentation correctly acknowledges this limitation.

Recommendation: Use Vercel Deployment Protection, an edge/server authentication layer, or server-side environment-specific authorization for previews. Keep the variable empty in production and do not place sensitive data behind this component.

Mitigation already present: the production checklist explicitly says this is not access control and recommends Deployment Protection.

Status: Intentionally not changed per request. This remains a temporary product-preview control only.

### SEC-002 — Content Security Policy is report-only

Severity: Medium

Location: [vercel.json:18-24](/Users/hannahwaxman/Documents/ark-media/insider/vercel.json:18)

Evidence: the deployment sets `Content-Security-Policy-Report-Only` rather than `Content-Security-Policy`.

Impact: The policy can provide telemetry through `/api/csp-report`, but it does not prevent execution of an injected script, loading of an unexpected resource, or framing that would otherwise violate the policy. This materially reduces defense in depth against XSS and supply-chain mistakes. The policy also permits `style-src 'unsafe-inline'`; that is a weaker control, though it is separate from the report-only issue.

Recommendation: Validate the current policy using the existing report endpoint, then ship an enforcing `Content-Security-Policy` header. Preserve only the required Stripe, PostHog, Sentry, media, and embedded-content sources. Remove `unsafe-inline` where the application can use nonces or hashes for styles.

Status: Fixed. `vercel.json` now emits `Content-Security-Policy`. The existing `style-src 'unsafe-inline'` remains because the client uses React inline style properties for dynamic presentation; the policy is now enforced while preserving those legitimate styles.

### SEC-003 — Gift claim bearer token is readable from sessionStorage

Severity: Low

Location: [src/lib/observability.ts:153-160](/Users/hannahwaxman/Documents/ark-media/insider/src/lib/observability.ts:153), [src/lib/observability.ts:194-210](/Users/hannahwaxman/Documents/ark-media/insider/src/lib/observability.ts:194), and [src/routes/redeem.tsx:87-92](/Users/hannahwaxman/Documents/ark-media/insider/src/routes/redeem.tsx:87)

Evidence: the legacy gift claim token is copied from the URL into `sessionStorage`, later read by the SPA, and cleared after a terminal outcome. It is a bearer credential used to complete a gift claim after an Auth0 round trip.

Impact: Any same-origin JavaScript that executes in the page can read the token during the claim window. A successful XSS, compromised first-party bundle, or overly permissive third-party script could steal it and attempt to claim the gift. The token is scoped to the gift flow and is cleared promptly, which limits severity, but browser storage is weaker than an HttpOnly server-side transaction.

Recommendation: Prefer a short-lived, server-held transaction keyed by an HttpOnly, SameSite cookie, or exchange the URL token once at the server before redirecting to Auth0. Continue removing the token from the URL before analytics initialization and keep the current prompt clearing behavior.

Status: Fixed. The client exchanges the raw legacy token through `/api/gift/prepare-claim`; the server sets a 15-minute `HttpOnly; Secure; SameSite=Lax` cookie, and `/api/gift/redeem` consumes and clears that cookie. No new browser-readable copy is created.

### SEC-004 — Beehiiv webhook authentication secret is transported in the URL

Severity: Low/Medium residual integration risk

Location: [server/routes/beehiiv.ts:346-375](/Users/hannahwaxman/Documents/ark-media/insider/server/routes/beehiiv.ts:346), and the event mutation path at [server/routes/beehiiv.ts:409-430](/Users/hannahwaxman/Documents/ark-media/insider/server/routes/beehiiv.ts:409)

Evidence: the webhook accepts `?key=...` and the source comments explicitly note that the value can appear in upstream access logs. A valid key allows event processing; the second-layer check limits processing to known readers but does not provide cryptographic event authenticity or prevent replay for those readers.

Impact: Leakage of a Vercel/CDN/proxy log or provider configuration can let an attacker replay or forge Beehiiv events for existing readers, potentially changing mirrored subscription or private-feed state.

Recommendation: Use a provider-supported signed header/HMAC if Beehiiv adds one. Until then, rotate the secret at launch and periodically, restrict log access and retention, monitor unusual event patterns, and preserve the existing known-reader check and idempotency ledger. Treat the key as compromised if it appears in logs or support tooling.

Status: Partially mitigated in code. The endpoint now supports the dedicated `x-beehiiv-webhook-secret` header and gives it precedence over the query parameter. The query fallback remains for the current provider integration; a complete fix requires configuring Beehiiv or a trusted intermediary to deliver the secret in the header and then removing the legacy query URL.

## Positive security controls observed

- Auth0 callback flow uses PKCE, state, nonce, issuer/audience checks, and a signed short-lived transaction cookie.
- Session cookies are HttpOnly, Secure in Vercel environments, and SameSite=Strict outside local development.
- Authenticated state-changing routes generally enforce same-origin checks and require fresh or durable authentication where appropriate.
- Admin mutations require the admin role and use live role checks that fail closed on lookup errors.
- HTML rendering uses allowlists and URL scheme checks; no direct `dangerouslySetInnerHTML`, `eval`, `new Function`, or `document.write` sinks were found in the application code scan.
- Request bodies, upstream fetches, and several expensive provider operations are bounded; payment and public checkout paths have rate limits.
- Stripe webhook handling verifies provider signatures, and SQL access is parameterized in the reviewed paths.
- `pnpm lint` passed.
- `pnpm test` passed: 2,092 tests, 0 failures.

## Validation limits

`pnpm audit --prod` could not complete because the environment could not resolve `registry.npmjs.org` (`ENOTFOUND`). Dependency advisories therefore remain unverified in this review; rerun the command from a networked CI or developer environment.

This was a repository review, not a live authenticated penetration test. It did not verify Vercel Deployment Protection, production environment variables, Auth0 tenant settings, Stripe dashboard configuration, Beehiiv webhook configuration, database permissions, or third-party account settings.
