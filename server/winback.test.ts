// The win-back campaign's decision rules. Pure — no DB, no email — so each
// disqualification is pinned on its own.
//
// The rules matter more than most: this is the only mail the app sends to
// someone who is no longer a customer, so every one of these guards is the
// difference between an invitation and a nuisance.

import { describe, test, expect } from 'bun:test'
import {
  WINBACK_AFTER_DAYS,
  candidateFor,
  type WinbackRow,
} from './lib/winback'
import { renderFoldWinbackEmail, renderWinbackEmail } from './lib/winback-email'

const PARAMS = { rejoinUrl: 'https://ark.test/fold', unsubscribeUrl: 'https://ark.test/unsub' }
import { mailableStatus } from './lib/beehiiv-status'

function row(over: Partial<WinbackRow> = {}): WinbackRow {
  return {
    email: 'left@example.com',
    canceled_tier: 'ark-plus',
    retained_product: 'full-exit',
    has_premium: false,
    status: 'active',
    ...over,
  }
}

const CLEAR = { suppressed: false, alreadySent: false }

describe('candidateFor', () => {
  test('a full exit from Ark+ six months ago is the campaign', () => {
    expect(candidateFor(row(), CLEAR)).toEqual({ email: 'left@example.com', campaign: 'ark_plus' })
  })

  test('a bundle canceller gets the Ark+ email — they had Ark+ too, and one win-back is enough', () => {
    expect(candidateFor(row({ canceled_tier: 'bundle' }), CLEAR)?.campaign).toBe('ark_plus')
  })

  test('a Fold-only canceller gets the Fold email, never the Ark+ one', () => {
    // The Ark+ copy speaks entirely about Ark+ — ad-free listening, early
    // access, bonus episodes. Someone who only ever had the Fold would be
    // invited back to a product they never had.
    expect(candidateFor(row({ canceled_tier: 'circle' }), CLEAR)).toEqual({
      email: 'left@example.com',
      campaign: 'fold',
    })
  })

  test('a Fold leaver who holds the Fold again is left alone', () => {
    expect(candidateFor(row({ canceled_tier: 'circle' }), { ...CLEAR, onFold: true })).toBeNull()
    // The Fold check means nothing for an Ark+ leaver.
    expect(candidateFor(row(), { ...CLEAR, onFold: true })).not.toBeNull()
  })

  test('a Fold leaver who has taken Ark+ since is a customer again — no pitch', () => {
    expect(candidateFor(row({ canceled_tier: 'circle', has_premium: true }), CLEAR)).toBeNull()
  })

  test('a debundle gets neither — they kept something', () => {
    // "Since you left Ark+" is false for a member who is still paying for one
    // half of what they had, and a Fold pitch to someone who kept Ark+ is an
    // upsell to a customer, not a win-back.
    for (const canceled_tier of ['bundle', 'circle', 'ark-plus']) {
      expect(candidateFor(row({ canceled_tier, retained_product: 'kept-circle' }), CLEAR)).toBeNull()
      expect(candidateFor(row({ canceled_tier, retained_product: 'kept-ark-plus' }), CLEAR)).toBeNull()
    }
  })

  test('someone who already came back is left alone', () => {
    expect(candidateFor(row({ has_premium: true }), CLEAR)).toBeNull()
  })

  test('no Beehiiv record is not evidence of a live membership', () => {
    // A left join yields null for an address we hold nothing for. Treating that
    // as "still subscribed" would silently mail nobody.
    expect(candidateFor(row({ has_premium: null, status: null }), CLEAR)).not.toBeNull()
  })

  test('an unsubscribed or lapsed reader is never mailed', () => {
    for (const status of ['unsubscribed', 'inactive', 'INVALID', ' deleted ']) {
      expect(candidateFor(row({ status }), CLEAR)).toBeNull()
    }
  })

  test('opting out and having already been mailed each disqualify', () => {
    expect(candidateFor(row(), { suppressed: true, alreadySent: false })).toBeNull()
    expect(candidateFor(row(), { suppressed: false, alreadySent: true })).toBeNull()
  })

  test('a blank address is dropped rather than mailed', () => {
    expect(candidateFor(row({ email: '   ' }), CLEAR)).toBeNull()
  })

  test('the address is normalized, so the ledger and the send agree', () => {
    expect(candidateFor(row({ email: '  LEFT@Example.COM ' }), CLEAR)).toEqual({
      email: 'left@example.com',
      campaign: 'ark_plus',
    })
  })
})

describe('mailableStatus', () => {
  // Shared by all three campaigns — see lib/beehiiv-status.ts. Asserted here
  // because the win-back is the one that mails former customers, where getting
  // an opt-out wrong matters most.
  test('unknown and blank statuses fail open', () => {
    expect(mailableStatus(undefined)).toBe(true)
    expect(mailableStatus(null)).toBe(true)
    expect(mailableStatus('something-new')).toBe(true)
  })

  test('the known non-delivering statuses fail closed, case-insensitively', () => {
    expect(mailableStatus('Unsubscribed')).toBe(false)
    expect(mailableStatus('needs_attention')).toBe(false)
  })
})

describe('campaign horizon', () => {
  test('the constant and the copy agree on six months', () => {
    // Both emails say "It's been six months since you left" in prose. If this
    // number moves, those sentences become a lie — so they move together.
    expect(WINBACK_AFTER_DAYS).toBe(180)
    expect(renderWinbackEmail(PARAMS).html).toContain('six months since you left Ark+')
    expect(renderFoldWinbackEmail(PARAMS).html).toContain('six months since you left the Fold')
  })
})

describe('renderFoldWinbackEmail', () => {
  test('the approved subject, CTA target and opt-out', () => {
    const { subject, html } = renderFoldWinbackEmail({ ...PARAMS, firstName: 'Rae' })
    expect(subject).toBe('The conversation kept going')
    expect(html).toContain('Hi Rae,')
    expect(html).toContain('href="https://ark.test/fold"')
    expect(html).toContain('Rejoin the Fold')
    expect(html).toContain('Dan&rsquo;s book club')
    expect(html).toContain('href="https://ark.test/unsub"')
    // Nothing about Ark+ in a Fold-only leaver's email.
    expect(html).not.toContain('Ark+')
  })
})
