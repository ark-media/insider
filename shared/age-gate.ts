// ---------------------------------------------------------------------------
// Community 18+ age gate — the one place the attestation is defined.
//
// Ark's community (the `circle` entitlement axis) is an adults-only space, so a
// buyer must assert they are 18 or older BEFORE they can enter card details on
// any purchase that grants it. The assertion is recorded as metadata on the
// Stripe Subscription, which is why the key and the sentence live in the same
// file: the copy a buyer ticked and the record we would produce in a dispute
// cannot drift apart if there is only one of each.
//
// What this module encodes (tasks/prd-age-gate.md):
//   D2  Stripe stringifies every metadata value, so the record reads back as
//       the STRING 'true', never a boolean — compare against AGE_METADATA_VALUE.
//   D3  The key is written only when the purchase grants `circle`. An Ark+
//       subscription carries no key at all: absence means never attested.
//   D4  It is never written as 'false'. The server refuses the request instead,
//       so a `circle` entitlement that skipped the gate cannot exist. That
//       refusal — not the checkbox — is what makes the record load-bearing.
//   D7  Attestation, not verification. No date of birth: it is PII we would
//       have to protect, invites a COPPA problem the moment an under-13 enters
//       one, and is no more verifiable than a tick. The buyer's assertion is
//       the point; liability moves because they made it.
// ---------------------------------------------------------------------------

/** Stripe `subscription_data.metadata` key holding the attestation. */
export const AGE_METADATA_KEY = 'confirmed_age_18'

/**
 * The only value ever written (D4 — the alternative to 'true' is a 400, not a
 * 'false'). A string because Stripe stringifies metadata regardless, so reads
 * must compare against a string too.
 */
export const AGE_METADATA_VALUE = 'true'

/**
 * The exact sentence the buyer ticks. Single-sourced so the UI copy and the
 * record can't diverge, and so a future audit has one place to read what was
 * actually asserted.
 */
export const AGE_STATEMENT = 'I confirm that I am 18 years of age or older.'

/**
 * The gift variant: the buyer is attesting about someone else, so it cannot be
 * the first-person sentence above. Kept as its own constant precisely because
 * the two are NOT interchangeable — a record of what a giver believed about a
 * recipient is a weaker thing than a record of what a buyer asserted about
 * themselves, and the wording is the only place that difference is visible.
 */
export const AGE_STATEMENT_RECIPIENT =
  'I confirm that the recipient is 18 years of age or older.'

/** Machine-readable discriminator on the 400 every gated endpoint returns. */
export const AGE_GATE_ERROR_CODE = 'age_confirmation_required'

/** Human-readable half of that 400. A client that gates properly never sees it. */
export const AGE_GATE_ERROR =
  'Community access is 18+. Please confirm your age to continue.'

/** The same 400, phrased for the giver on the gift funnel. */
export const AGE_GATE_ERROR_GIFT =
  'Community access is 18+. Please confirm the recipient is 18 or older to continue.'

// The tiers that carry the `circle` axis. The SERVER never reads this list — it
// asks deriveEntitlements(tier).circle, so a future tier that includes community
// is gated the moment it exists (D6). This mirror exists for the client, which
// has no entitlement module; server/entitlement.test.ts asserts the two agree
// for every tier, so the mirror can't silently fall behind.
const COMMUNITY_TIERS: ReadonlySet<string> = new Set(['circle', 'bundle'])

/** Whether buying this tier grants community access, and so needs the gate. */
export function requiresAgeGate(tier: string): boolean {
  return COMMUNITY_TIERS.has(tier)
}
