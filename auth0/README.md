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

1. **Account linking** — a member's first login on any non-Database connection
   (Google, or the passwordless `email` connection behind "email me a sign-in
   code") is linked into their canonical Database account
   (`Username-Password-Authentication`), which is then made primary for the
   session.
2. **Signup gate** — a login on either of those with no matching Database
   account is a self-signup: it's rejected and the JIT-provisioned orphan is
   deleted. For Google this is the only barrier. The passwordless connection
   has its own ("Disable Sign Ups", below), so there the gate is a backstop in
   case that toggle is ever turned off.
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
The same step creates the member's passwordless `email` identity and links it
into that account (see *Passwordless email*), so a code login never reaches the
linking branch at all — it is already linked.

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
   gate in this action covers the social and passwordless connections; the
   dashboard toggle covers the Database connection.

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
   `name_set_by_member` claim reads on the linking login.)

## Passwordless email (the "email me a code" option)

The way into the site for members without Google, now that the password
option has been removed from the login page. It is Auth0's
**email OTP** passwordless connection: the member types their address and Auth0
emails them a one-time code.

**It is a code, not a clickable magic link.** Auth0's magic-link variant is
[not supported on New Universal Login](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-magic-link)
— it only runs on the legacy Classic login page, and even there the link has to
be opened in the same browser that asked for it. Switching the tenant to Classic
to get a clickable link would cost us the New Universal Login page and its
branding, so we take the code.

**Auth0 only offers it because the password option is gone.** This is the part
that is easy to get wrong, in both directions. Per
[Passwordless with Universal Login](https://auth0.com/docs/authenticate/passwordless/passwordless-with-universal-login),
when an application has **both** a database connection and a passwordless one,
New Universal Login renders no passwordless choice next to the password form;
Auth0's stated reason is that a passwordless connection signs people up on
sight, so offering it beside a password box could silently create a duplicate
account for anyone whose email misses the database.

We lived with that for a day (2026-09-16): the connection was enabled, did
nothing on its own, and we carried our own "Email me a code instead" link on
four surfaces to reach it. Then the password option was taken off the login
page, which leaves the passwordless connection unshadowed — Auth0 now renders
the code prompt itself, so those links were removed again (they were duplicating
a choice the widget already offers).

⚠️ **This is conditional, not permanent.** Put password login back in front of
members and the code prompt disappears from the widget on the same day, silently
— nothing errors, the option simply stops being drawn, and the only way back is
`connection=email` from our own UI. If you re-enable the database connection for
this application, restore an entry point in the same change.

Setup (Auth0 Dashboard):

1. **Authentication → Authentication Profile** → **Identifier First**.
   Passwordless in New Universal Login requires it, and until it is on, even the
   connection's own **Try** tab refuses to run. Note this is **tenant-wide**: it
   turns every login page in the tenant — the website's and Circle's SSO — into
   two steps, email first and password on the next screen. Google stays a button
   on the first screen.
2. **Authentication → Passwordless → Email** → enable.
3. Set **Verification Method** to **One-time password (OTP)**. (`Magic Link`
   here is the Classic-only variant above — it will silently not appear on our
   login page.)
4. Fill in *From*, *Subject*, and the message template so the code email matches
   the rest of our lifecycle mail, and set the OTP expiry/length.
5. **Authentication → Passwordless → Email → Settings → Disable Sign Ups is
   ON**, and that only works because we create every member's `email` identity
   ourselves. With signups disabled, Auth0 will send a code only to an address
   that already has an `email` identity. Anyone else is refused before a code
   exists:

   ```
   POST /passwordless/start → 400
   {"error":"bad.connection","error_description":"Public signup is disabled"}
   ```

   (In the tenant logs: *Failed Login — Public signup is disabled*, connection
   `email`.) No code is generated, so **no email is ever sent**, which looks
   exactly like an email-delivery problem and isn't one. Strangers hitting this
   is the point. A *member* hitting it means their identity is missing.

   Provisioning creates it: `linkEmailCodeLogin` in `server/lib/auth0-user.ts`
   runs inside `findOrCreateAuth0User`, adds a record on the `email` connection
   and links it into the Database account. That covers every webhook and gift
   member, and repairs an older member the next time they're provisioned.
   Anyone else (members provisioned before 2026-09-16, and staff, admins or
   comps created by hand in the dashboard) needs the backfill, which is safe to
   re-run:

   ```
   bun run scripts/backfill-email-code-login.ts            # preview
   bun run scripts/backfill-email-code-login.ts --apply
   bun run scripts/backfill-email-code-login.ts --apply --email someone@x.com
   ```

   **Testing with your own account won't catch a gap:** once your identity
   exists, your codes keep arriving whatever the toggle says. To see who's
   covered, run the preview.

   Why ON rather than OFF: with signups allowed, the connection mails a code to
   any address typed into the login box, and it puts a "Don't have an account?
   Sign up" link on the login page that can't be hidden. It ran OFF on
   2026-09-15, relying on the post-login gate to deny non-members after they
   entered their code. That gate is still in place (post-login.js, the
   `!primary` branch), so flipping the toggle back OFF is a safe fallback, just
   a noisier one.

6. Enable the connection for the website's application — **ArkPlus** (Regular
   Web Application, client id `1T1u9VRHbSWx0wy80X5PVYw9BdPNtAvp`, i.e.
   `AUTH0_WEB_CLIENT_ID`). Two equivalent routes to the same switch: the
   connection's own **Applications** tab, or Applications → ArkPlus →
   **Connections** → Passwordless. Leave it **off** for Circle's Custom SSO
   application unless we want Fold members signing in that way too — the Fold
   gate in this action keys on client id and keeps working either way.

The app side is still wired even though nothing in the UI calls it now:
`/api/auth/login?connection=email` (`server/routes/auth.ts`, allowlisted in
`LOGIN_CONNECTIONS`) opens that prompt directly, and
`signIn(returnTo, { connection: "email" })` in `src/lib/subscriberAuth.tsx` is
the client-side spelling. Kept deliberately, for two reasons: it is the link
support hands a member who is stuck, and it is the thing to re-mount in the UI
if password login ever returns to the login page.

## Behavior notes / gotchas

- **Email must match.** A member whose Google email differs from their
  subscription email has no matching Database account and will be rejected as a
  stranger. Inherent to using email as the join key — document it for support.
  The passwordless connection is the workaround to hand support: a member who
  signs in with the code sent to their *subscription* address always matches.
- **Non-members get no code.** With signups disabled on the passwordless
  connection, a stranger's code request is refused and nothing is mailed; the
  login page shows an error instead. "I never got my code" from a *member*
  therefore means a missing `email` identity. Run the backfill with `--email`.
- **A member with no password has a way in.** Members are provisioned without
  one and set it from a reset email they may never open; gift recipients are
  provisioned at claim time. Before this connection existed their only options
  were that reset email or Google.
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
