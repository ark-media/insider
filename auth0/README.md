# Auth0 Actions

Version-controlled copies of the custom code that runs inside our Auth0 tenant.
Auth0 has no native "deploy from repo" for hand-written Actions, so **the
dashboard is the live source of truth** — these files are the reviewed canonical
copy. When you change behavior, edit the file here in a PR *and* paste it into
the dashboard (keep them in sync). Actions run in Auth0's Node runtime as
CommonJS (`exports.onExecutePostLogin`), which is why this is `.js` and outside
the app's TypeScript build — ESLint only lints `**/*.{ts,tsx}`, so it's ignored
by CI tooling on purpose.

## `actions/post-login.js`

The **single** Post-Login action in the Login flow. It owns three concerns that
have to be resolved against the same (primary) user, so they live together:

1. **Account linking** — a member's first social (Google) login is linked into
   their canonical Database account (`Username-Password-Authentication`), which
   is then made primary for the session.
2. **Signup gate** — a social login with no matching Database account is a
   self-signup: it's rejected and the JIT-provisioned orphan is deleted.
3. **Claims** — sets `…/email`, `…/given_name`, `…/family_name`,
   `…/name_set_by_member`, `…/roles` (namespace and names from
   `shared/auth0-claims.ts`), resolved from the primary user. There is **no**
   `…/tier` claim: Auth0 carries no entitlement, and access is a live Neon read
   on the sub.

### Why members are always found on the Database connection

The activation webhook creates every paying/gift member on the
`Username-Password-Authentication` connection *before* they ever log in
(`server/lib/auth0-user.ts` → `findOrCreateAuth0User`), and stamps
`app_metadata.tier` via the Management API (`server/entitlement.ts`). So "does a
Database account exist for this email?" is exactly "is this a real member?".

### Why the Management API calls are unavoidable

`event` is a snapshot of the *one* user authenticating. It cannot see whether a
*different* record exists for the same email (`users-by-email`), persist an
identity merge (`POST /users/{id}/identities`), or delete a record.
`api.authentication.setPrimaryUser()` only swaps the token subject for the
current session — it does **not** durably link the accounts. The management
token is cached across executions via `api.cache`, so `/oauth/token` isn't hit
on every login.

## Deploy / setup

1. **Connection prerequisite.** Authentication → Database →
   `Username-Password-Authentication` → **Disable Sign Ups** must be ON. The
   gate in this action only covers social connections; the dashboard toggle
   covers the Database connection.

2. **Create/replace the action.** Actions → Library → (the Post-Login action) →
   paste `actions/post-login.js` → Deploy. This action **supersedes** any
   standalone signup-gate or tier-claim action — remove those so nothing
   double-writes the tier claim.

3. **Add it to the flow.** Actions → Flows → Login → ensure this is the action
   in the flow → Apply.

4. **Secrets** (Action → Settings → Secrets):
   | Name | Value |
   |---|---|
   | `AUTH0_TENANT_DOMAIN` | native tenant domain, e.g. `ark-media.us.auth0.com` (scheme optional — `https://ark-media.us.auth0.com` also works; `tenantBase()` normalizes it to match the app's env in `server/auth0.ts`). **Not** the custom login domain `auth.ark-plus.xyz` — the Management API lives on the native domain. |
   | `MGMT_CLIENT_ID` | Ark Plus M2M client id |
   | `MGMT_CLIENT_SECRET` | Ark Plus M2M client secret |

5. **M2M scopes** (Applications → Ark Plus M2M → APIs → Auth0 Management API):
   `read:users`, `update:users`, `delete:users`, `read:roles`,
   `read:users_app_metadata`. (`update:users` is required for linking —
   `update:users_app_metadata` alone is not enough. `read:users_app_metadata`
   is what makes `users-by-email` return `app_metadata`, which the
   `name_set_by_member` claim reads on the social-linking login.)

## Behavior notes / gotchas

- **Email must match.** A member whose Google email differs from their
  subscription email has no matching Database account and will be rejected as a
  stranger. Inherent to using email as the join key — document it for support.
- **The Database account's own `email_verified` is not required.** The webhook
  provisions members with `email_verified:false` (they set a password via the
  reset email rather than verifying), so a member who signs in with Google
  *before* doing that reset still has an unverified Database account. The gate
  keys only on whether a Database account *exists*; the *social* email is what
  must be verified (proving control of the address the accounts share). An
  earlier version also required `primary.email_verified === true`, which
  rejected Google-first members as self-signups and deleted their identity.
- **Roles on the first social login.** `event.authorization.roles` reflects the
  secondary (social) user mid-run, so on the linking login the action fetches
  the primary's roles via the Management API. Every login after the merge reads
  them from `event.authorization` with no extra call.
- **Database and already-linked logins cost nothing.** They skip the linking
  block entirely; claims are set straight from `event`.
- **`name_set_by_member` degrades quietly, and only for one shape of name.** If
  the claim is absent (action not yet deployed, or the M2M client is missing
  `read:users_app_metadata`), the app falls back to its manufactured-name
  heuristic. That is correct for nearly everyone — a surname, or a first name
  that isn't their lowercase email local part, is judged real on sight. The one
  member it affects is someone like `sarah@gmail.com` who saved "sarah" with no
  surname: after a re-login `/api/me` stops returning her `firstName`, so the
  greeting reverts to "Welcome back." `/account` is unaffected either way — it
  reads Auth0 through the Management API and sees the flag directly. So there is
  no deploy ordering constraint between the app and this action.
- **Fails closed.** A missing verified email, an unresolvable management token,
  or a failed link all `deny()` rather than letting an unverified/ orphan
  session through.

## Related code

- `shared/auth0-claims.ts` — claim namespace + names this action must match.
- `server/lib/auth0-user.ts` — webhook-side member provisioning (Database conn).
- `server/entitlement.ts` — Management-API tier/Circle sync + reconciler.
- `server/routes/stripe.ts` — webhook that drives provisioning + entitlement.
