/**
 * Auth0 Post-Login Action — Ark Plus.
 *
 * This is the SINGLE Post-Login action in the Login flow. It does four things:
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
 *   3. The Fold (Circle) login gate. Circle's Custom SSO points at its own
 *      Auth0 Application; when the login is for THAT client, refuse it unless
 *      the member holds the `circle` entitlement. Circle cannot do this itself —
 *      it reads no roles or claims to decide access, and it auto-provisions a
 *      community member for anyone who completes the handshake — so an
 *      Ark+-only subscriber would otherwise walk into the Fold silently,
 *      the website's live Auth0 session carrying them straight through. The
 *      entitlement is a live read against the site (see circleAccess below);
 *      this action still stores none of it.
 *
 *   4. Claims. Set the email / name / name-provenance / roles custom claims the
 *      app reads. These MUST be resolved from the primary (Database) user:
 *      after api.authentication.setPrimaryUser(), event.user /
 *      event.authorization still reference the secondary social user for the
 *      rest of this run, so reading roles off `event` would be wrong on the
 *      linking login.
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
 *   CIRCLE_CLIENT_ID      client_id of the Auth0 Application Circle's Custom SSO
 *                         authorizes against. MUST be a DIFFERENT application
 *                         from the website's (AUTH0_WEB_CLIENT_ID) — they shared
 *                         one until this gate landed, and with a shared id the
 *                         gate below would turn away website logins too. If this
 *                         secret is unset the gate silently does nothing (there
 *                         is no way to recognise Circle's transaction without
 *                         it), so the action logs a warning; treat that line in
 *                         the Auth0 logs as "the Fold is currently open".
 *   APP_BASE_URL          origin of the marketing site, e.g. https://arkmedia.org
 *                         (scheme optional). Used both to call the entitlement
 *                         gate and to send an unentitled member to the upsell.
 *   CIRCLE_GATE_SECRET    shared secret for POST /api/internal/circle-access;
 *                         must equal the site's CIRCLE_GATE_SECRET env var.
 *
 * M2M scopes required: read:users, update:users, delete:users, read:roles, and
 * read:users_app_metadata (users-by-email omits app_metadata without it, which
 * silently costs the name_set_by_member claim on the social-linking login only).
 *
 * Claim namespace must match AUTH0_CLAIM_NAMESPACE in shared/auth0-claims.ts.
 * ---------------------------------------------------------------------------
 */

const NS = 'https://ark-plus.xyz';
const DB_CONNECTION = 'Username-Password-Authentication';

// Budget for the entitlement lookup. Generous on purpose: the gate fails CLOSED,
// so a timeout turns a paying member away, and the site's function can be cold.
// An action gets ~20s in total, and this call is the only network hop on a
// Fold login beyond the (cached) management token, so 5s costs nothing on
// the happy path and removes cold-start false negatives.
const CIRCLE_GATE_TIMEOUT_MS = 5000;

// The AUTH0_TENANT_DOMAIN secret may be set with or without a scheme/trailing
// slash — the app's own env (server/auth0.ts) includes the scheme, so accept
// either rather than assuming a bare host. Returns e.g. https://foo.us.auth0.com.
function tenantBase(event) {
  const raw = (event.secrets.AUTH0_TENANT_DOMAIN || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
}

// Origin of the marketing site, normalized the same way tenantBase normalizes
// the tenant domain — the two secrets are set by hand in the Auth0 dashboard and
// there is no reason for one to be fussier about a scheme than the other.
function appBase(event) {
  const raw = (event.secrets.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
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

  // --- The Fold (Circle) login gate -----------------------------------------
  // Keyed strictly on the client id so a website login can never reach it: this
  // is the one branch that can turn away a member who is otherwise perfectly
  // authenticated, and the two applications were a single Auth0 client until
  // this shipped. `resolved.user_id` — not event.user.user_id — is the key: the
  // membership row is keyed on the DATABASE account's sub, which on the
  // social-linking path above is `primary`, and reading the secondary social
  // sub here would find no row and turn a paying member away.
  const circleClientId = event.secrets.CIRCLE_CLIENT_ID;
  if (!circleClientId) {
    console.warn('[circle-gate] CIRCLE_CLIENT_ID unset — Fold SSO is ungated');
  } else if (event.client.client_id === circleClientId) {
    const verdict = await circleAccess(event, resolved.user_id);
    if (verdict === 'error') {
      // "We could not check" is NOT "you are not entitled" — say so, and let
      // them retry, rather than sending a paying member to a sales page.
      return api.access.deny(
        'We could not verify your Fold access just now. Please try again.',
      );
    }
    if (verdict === 'deny') {
      // Someone who bought the podcasts and clicked a Fold link. Auth0's
      // own denial screen is a dead end; send them to the page that sells them
      // the thing they just tried to open. This abandons the login transaction
      // by design — they never return to /continue, so Circle never gets a
      // callback and never auto-provisions them a member.
      //
      // appBase() is guaranteed non-empty here: circleAccess returns 'error'
      // when APP_BASE_URL is unset, so this line is unreachable without it.
      // Keep that invariant if either function is edited — a relative URL here
      // would throw inside the action instead of redirecting.
      return api.redirect.sendUserTo(`${appBase(event)}/plus?from=fold`);
    }
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

  // Provenance for the name above (shared/profile-name.ts). For most of this
  // site's life we *manufactured* a name when we had none — given_name was set
  // to the email's local part — so the app can't trust a stored name on sight:
  // it judges one real only if a surname sits beside it, or it differs from the
  // local part, or it carries a capital that value could never have had. That
  // heuristic has exactly one blind spot, and it is not hypothetical: "sarah",
  // typed by sarah@gmail.com, is character-for-character what we would have
  // manufactured for her. This flag — written to app_metadata by
  // PUT /api/account/profile when a member types their name — is the only thing
  // that settles it. Without the claim, her name reverts to being read as junk
  // on her next login and /api/me stops greeting her by it.
  //
  // Set unconditionally, unlike the two names above: the app reads `=== true`,
  // so an absent claim and `false` mean the same thing to it, and an explicit
  // false makes a decoded token say which of the two it is.
  //
  // `resolved`, not `event.user`, for the usual reason — but note this one is
  // the reverse of the others: the flag lives on the DATABASE account (the sub
  // the profile save targets), so on the social-linking login it is only ever
  // on `primary`. users-by-email returns app_metadata, provided the M2M client
  // holds read:users_app_metadata (see the scope list above).
  api.accessToken.setCustomClaim(
    `${NS}/name_set_by_member`,
    resolved.app_metadata?.name_set_by_member === true,
  );

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

// --- The Fold entitlement ---------------------------------------------------

// Ask the site whether this member holds the `circle` entitlement. Three-valued
// on purpose: 'allow' / 'deny' / 'error', because the caller must treat "not
// entitled" and "could not check" differently — one is a sales page, the other
// is a retry.
//
// The lookup is a service call rather than a claim or an app_metadata read
// because Auth0 deliberately carries no entitlement: membership lives in Neon
// and is read live, so a member who upgraded a minute ago is let in and one who
// cancelled is not. It is a service call rather than a direct database read
// because the tier -> entitlement map (GRANTS) must exist in exactly one place;
// re-deriving "which tiers include the Fold" here is how a login gate ends
// up disagreeing with the content gates.
//
// Not cached. api.cache is a small tenant-wide store and a per-member key would
// both crowd it and let a cancelled member back in for the life of the entry —
// poor value when a Fold login is a rare event and the call is one hop.
async function circleAccess(event, sub) {
  const base = appBase(event);
  const secret = event.secrets.CIRCLE_GATE_SECRET;
  if (!base || !secret) {
    console.error('[circle-gate] APP_BASE_URL or CIRCLE_GATE_SECRET unset');
    return 'error';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CIRCLE_GATE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/internal/circle-access`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sub }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[circle-gate] lookup ${res.status}`);
      return 'error';
    }
    const body = await res.json();
    // Require the boolean. A 200 carrying an unexpected shape is a bug on our
    // side, and reading it as `deny` would send a paying member to the upsell.
    if (typeof body?.allow !== 'boolean') {
      console.error('[circle-gate] unexpected response shape');
      return 'error';
    }
    return body.allow ? 'allow' : 'deny';
  } catch (err) {
    console.error('[circle-gate] lookup failed:', err);
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}
