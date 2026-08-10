/**
 * Auth0 Post-Login Action — Ark Plus.
 *
 * This is the SINGLE Post-Login action in the Login flow. It does three things:
 *
 *   1. Account linking. When a member logs in with a social connection (Google)
 *      for the first time, link that identity into the canonical Database
 *      account (Username-Password-Authentication) and make the Database account
 *      primary for the session. Members are always provisioned on the Database
 *      connection by the activation webhook (server/lib/auth0-user.ts) before
 *      they ever log in, so the Database record is the source of truth for
 *      roles (Auth0 holds no entitlement — that lives in Neon, task 5).
 *
 *   2. Signup gate. Self-signup on the Database connection is disabled in the
 *      dashboard, but social connections JIT-provision a new user on first
 *      login with no toggle to stop it. So a social login with NO matching
 *      Database account is a self-signup: reject it and delete the orphan
 *      record Auth0 created before this action ran.
 *
 *   3. Claims. Set the email / roles custom claims the app reads. These MUST be
 *      resolved from the primary (Database) user: after
 *      api.authentication.setPrimaryUser(), event.user / event.authorization
 *      still reference the secondary social user for the rest of this run, so
 *      reading roles off `event` would be wrong on the linking login.
 *      Auth0 carries NO entitlement (task 5): there is no tier claim — access is
 *      a live Neon read on the sub, so nothing here reflects membership.
 *
 * Why the Management API calls are unavoidable: `event` is a snapshot of the
 * one authenticating user; it cannot see whether a *different* record exists
 * for the same email (users-by-email), nor persist an identity merge
 * (POST /users/{id}/identities), nor delete a record. setPrimaryUser only
 * changes the token subject for this session — it does not durably link.
 *
 * ---------------------------------------------------------------------------
 * Secrets (Action → Settings → Secrets):
 *   AUTH0_TENANT_DOMAIN   native tenant domain, e.g. ark-media.us.auth0.com or
 *                         https://ark-media.us.auth0.com (scheme optional —
 *                         tenantBase() normalizes it, matching the app's env in
 *                         server/auth0.ts, which includes the scheme). NOT the
 *                         custom login domain auth.ark-plus.xyz — the Management
 *                         API lives on the native domain.
 *   MGMT_CLIENT_ID        Ark Plus M2M client id.
 *   MGMT_CLIENT_SECRET    Ark Plus M2M client secret.
 *
 * M2M scopes required: read:users, update:users, delete:users, read:roles.
 *
 * Claim namespace must match AUTH0_CLAIM_NAMESPACE in shared/auth0-claims.ts.
 * ---------------------------------------------------------------------------
 */

const NS = 'https://ark-plus.xyz';
const DB_CONNECTION = 'Username-Password-Authentication';

// The AUTH0_TENANT_DOMAIN secret may be set with or without a scheme/trailing
// slash — the app's own env (server/auth0.ts) includes the scheme, so accept
// either rather than assuming a bare host. Returns e.g. https://foo.us.auth0.com.
function tenantBase(event) {
  const raw = (event.secrets.AUTH0_TENANT_DOMAIN || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

exports.onExecutePostLogin = async (event, api) => {
  // The user who just authenticated, and their roles, are the defaults used
  // for both the Database-login and already-linked-social cases.
  let resolved = event.user;
  let roles = event.authorization?.roles ?? [];

  const isSocial = event.connection.strategy !== 'auth0';
  const alreadyLinked = (event.user.identities || []).some(
    (i) => i.connection === DB_CONNECTION,
  );

  // --- Account linking + signup gate (unlinked social logins only) ---------
  if (isSocial && !alreadyLinked) {
    const email = event.user.email;
    // Only act on a verified email, or linking could attach to someone else's
    // account (or a self-signup could slip through with a spoofed address).
    if (!email || event.user.email_verified !== true) {
      return api.access.deny('A verified email is required to sign in.');
    }

    const token = await mgmtToken(event, api);
    if (!token) {
      return api.access.deny('Could not verify membership. Please try again.');
    }

    // Look for the canonical Database account provisioned by the webhook.
    const users = await usersByEmail(event, token, email);
    const primary = users.find(
      (u) =>
        u.user_id !== event.user.user_id &&
        (u.identities || []).some((i) => i.connection === DB_CONNECTION),
    );

    // No Database account → genuine self-signup. Block and clean up the orphan
    // record Auth0 JIT-created on this login.
    //
    // We deliberately do NOT require the Database account's own email_verified
    // flag. Members are provisioned by the webhook with email_verified:false
    // (findOrCreateAuth0User) and set a password via the reset email rather than
    // verifying, so a member who signs in with Google *before* doing that reset
    // still has an unverified Database account — requiring it here would reject
    // them as self-signups and delete their social identity. Linking is already
    // safe without it: the check above proved the *social* email is verified,
    // and users-by-email only returns records with that exact email, so Google
    // has confirmed the person controls the address the Database account uses.
    if (!primary) {
      await deleteUser(event, token, event.user.user_id).catch(() => {});
      return api.access.deny(
        'Membership is required to sign in. Please subscribe at arkmedia.org first.',
      );
    }

    // Link this social identity into the Database account; keep DB primary.
    const social = event.user.identities[0]; // the connection we just used
    try {
      await linkIdentity(event, token, primary.user_id, {
        provider: social.provider,
        user_id: social.user_id,
      });
    } catch (_err) {
      // Fail closed rather than leave an unlinked orphan social account.
      return api.access.deny('Could not link your account. Please contact support.');
    }

    // Continue the session as the Database account (carries tier + roles).
    api.authentication.setPrimaryUser(primary.user_id);

    // event.* still references the secondary social user for the rest of this
    // run, so resolve claims from the primary directly.
    resolved = primary;
    const primaryRoles = await userRoles(event, token, primary.user_id).catch(() => null);
    if (primaryRoles) roles = primaryRoles;
  }

  // --- Claims (set on every login, from the resolved user) ------------------
  // Auth0 carries NO entitlement: no tier claim. Access is a live Neon read on
  // the sub (tasks/entitlement-tiers.md §2/task 5). Only identity + the admin
  // roles claim ride the token.
  api.accessToken.setCustomClaim(`${NS}/email`, resolved.email);

  // Name rides the token so the app never spends a Management API read to greet
  // someone. Read from `resolved`, not `event.user` — on the social-linking path
  // above, event.user is still the secondary social record for the rest of this
  // run, which is why the email claim resolves the same way. Claims must be
  // namespaced; Auth0 silently drops a bare `name`.
  if (resolved.given_name) {
    api.accessToken.setCustomClaim(`${NS}/given_name`, resolved.given_name);
  }
  if (resolved.family_name) {
    api.accessToken.setCustomClaim(`${NS}/family_name`, resolved.family_name);
  }

  if (roles.length > 0) {
    api.accessToken.setCustomClaim(`${NS}/roles`, roles);
    api.idToken.setCustomClaim(`${NS}/roles`, roles);
  }
};

// --- Management API helpers -------------------------------------------------

// Client-credentials token, cached across executions via api.cache so we only
// hit /oauth/token when the cached token is near expiry. The per-user store
// calls below still run when needed, but this keeps the token mint off the
// common login path.
async function mgmtToken(event, api) {
  const cached = api.cache.get('mgmt_token');
  if (cached) return cached.value;

  const base = tenantBase(event);
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: event.secrets.MGMT_CLIENT_ID,
      client_secret: event.secrets.MGMT_CLIENT_SECRET,
      audience: `${base}/api/v2/`,
    }),
  });
  if (!res.ok) return null;
  const { access_token, expires_in } = await res.json();
  // Refresh a minute before Auth0 expires the token.
  api.cache.set('mgmt_token', access_token, {
    ttl: Math.max(60, (expires_in ?? 86400) - 60) * 1000,
  });
  return access_token;
}

async function usersByEmail(event, token, email) {
  const res = await fetch(
    `${tenantBase(event)}/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  return res.json(); // each record includes identities + app_metadata
}

async function userRoles(event, token, userId) {
  const res = await fetch(
    `${tenantBase(event)}/api/v2/users/${encodeURIComponent(userId)}/roles`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return (await res.json()).map((r) => r.name); // match the string[] claim shape
}

async function linkIdentity(event, token, primaryUserId, secondary) {
  const res = await fetch(
    `${tenantBase(event)}/api/v2/users/${encodeURIComponent(primaryUserId)}/identities`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(secondary), // { provider, user_id }
    },
  );
  if (!res.ok) throw new Error(`link ${res.status}: ${await res.text()}`);
  return res.json();
}

async function deleteUser(event, token, userId) {
  await fetch(
    `${tenantBase(event)}/api/v2/users/${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
}
