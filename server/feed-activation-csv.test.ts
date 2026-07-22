// Tests for the CSV-derived activation backfill's pure planner. The key
// behavior the download-derived backfill can't provide: crediting Spotify Open
// Access members (external_registration_type = spotify) who stream and never
// download.

import { describe, test, expect } from 'bun:test'
import { planCsvBackfill } from './lib/feed-activation-csv'

// A minimal header mirroring the SC export shape: email, the registration-type
// column, and one private feed's subscribe/download pair (20081) plus a public
// feed column pair (20080) that nobody gates.
const HEADER = [
  'email',
  'status',
  'external_registration_type',
  '20080_call-me-back_subscribed',
  '20080_call-me-back_downloads',
  '20081_inside-call-me-back_subscribed',
  '20081_inside-call-me-back_downloads',
]

// Helper to build a row aligned to HEADER.
function row(o: {
  email: string
  reg?: string
  s80?: string
  d80?: string
  s81?: string
  d81?: string
}): string[] {
  return [
    o.email,
    'active',
    o.reg ?? '',
    o.s80 ?? '',
    o.d80 ?? '0',
    o.s81 ?? '',
    o.d81 ?? '0',
  ]
}

describe('planCsvBackfill', () => {
  test('credits a download as activation', () => {
    const plan = planCsvBackfill(HEADER, [row({ email: 'a@x.com', d81: '3' })])
    expect(plan.seeds).toEqual([{ email: 'a@x.com', feedId: 20081, activatedAt: null }])
    expect(plan.fromDownloads).toBe(1)
    expect(plan.fromSpotify).toBe(0)
    expect(plan.membersNotActivated).toBe(0)
  })

  test('credits the subscribed=X flag as activation', () => {
    const plan = planCsvBackfill(HEADER, [row({ email: 'a@x.com', s81: 'X' })])
    expect(plan.seeds).toHaveLength(1)
    expect(plan.fromDownloads).toBe(1)
  })

  test('credits a Spotify-linked member with the private feed despite 0 downloads', () => {
    // A download member establishes 20081 as a real private feed (the only
    // signal for *which* feed a Spotify member streams); then the Spotify
    // member is credited with it even though their own downloads are 0.
    const plan = planCsvBackfill(HEADER, [
      row({ email: 'dl@x.com', d81: '1' }),
      row({ email: 'spot@x.com', reg: 'spotify' }),
    ])
    const spotSeeds = plan.seeds.filter((s) => s.email === 'spot@x.com')
    expect(spotSeeds).toEqual([{ email: 'spot@x.com', feedId: 20081, activatedAt: null }])
    expect(plan.fromSpotify).toBe(1)
    expect(plan.membersNotActivated).toBe(0)
  })

  test('cannot credit Spotify members when no feed is ever gated (unknowable feed)', () => {
    // Degenerate export: only Spotify members, so nothing establishes which
    // feed is private. Realistic exports always contain RSS members, but guard
    // the edge rather than crediting a guessed feed.
    const plan = planCsvBackfill(HEADER, [row({ email: 'spot@x.com', reg: 'spotify' })])
    expect(plan.privateFeeds).toEqual([])
    expect(plan.seeds).toHaveLength(0)
    expect(plan.membersNotActivated).toBe(1)
  })

  test('a member who neither downloaded nor linked Spotify is not activated', () => {
    const plan = planCsvBackfill(HEADER, [row({ email: 'none@x.com' })])
    expect(plan.seeds).toHaveLength(0)
    expect(plan.membersSeen).toBe(1)
    expect(plan.membersNotActivated).toBe(1)
  })

  test('does not credit a Spotify member with a public feed nobody gates', () => {
    // 20080 has no subscriber anywhere → not a private feed → never credited.
    const plan = planCsvBackfill(HEADER, [
      row({ email: 'sub@x.com', d81: '1' }), // establishes 20081 as private
      row({ email: 'spot@x.com', reg: 'spotify' }),
    ])
    expect(plan.privateFeeds).toEqual([20081])
    const spotSeeds = plan.seeds.filter((s) => s.email === 'spot@x.com')
    expect(spotSeeds).toEqual([{ email: 'spot@x.com', feedId: 20081, activatedAt: null }])
  })

  test('a pair both downloaded and Spotify-linked is counted once, as a download', () => {
    const plan = planCsvBackfill(HEADER, [
      row({ email: 'both@x.com', reg: 'spotify', d81: '5' }),
    ])
    expect(plan.seeds).toHaveLength(1)
    expect(plan.fromDownloads).toBe(1)
    expect(plan.fromSpotify).toBe(0)
  })

  test('dedupes across duplicate membership rows and normalizes email', () => {
    const plan = planCsvBackfill(HEADER, [
      row({ email: '  A@X.COM ', d81: '1' }),
      row({ email: 'a@x.com', d81: '9' }), // same member, second membership
    ])
    expect(plan.seeds).toEqual([{ email: 'a@x.com', feedId: 20081, activatedAt: null }])
    expect(plan.membersSeen).toBe(1)
    expect(plan.membersActivated).toBe(1)
  })

  test('a duplicate row activates the member even if the first row did not', () => {
    const plan = planCsvBackfill(HEADER, [
      row({ email: 'dl@x.com', d81: '1' }), // establishes 20081 as private
      row({ email: 'a@x.com' }), // no activity on this membership
      row({ email: 'a@x.com', reg: 'spotify' }), // linked on the other membership
    ])
    expect(plan.membersNotActivated).toBe(0)
    expect(plan.fromSpotify).toBe(1)
  })

  test('skips rows with a blank email', () => {
    const plan = planCsvBackfill(HEADER, [row({ email: '   ', d81: '1' })])
    expect(plan.seeds).toHaveLength(0)
    expect(plan.membersSeen).toBe(0)
  })

  test('throws when the email column is absent', () => {
    expect(() => planCsvBackfill(['status', 'plan'], [])).toThrow(/email/)
  })

  test('works when the export has no registration-type column (no Spotify credit)', () => {
    const noReg = ['email', '20081_inside_subscribed', '20081_inside_downloads']
    const plan = planCsvBackfill(noReg, [
      ['spot@x.com', '', '0'], // would be Spotify, but no column to prove it
      ['dl@x.com', '', '2'],
    ])
    expect(plan.fromSpotify).toBe(0)
    expect(plan.membersNotActivated).toBe(1) // spot@x.com uncredited
    expect(plan.seeds).toEqual([{ email: 'dl@x.com', feedId: 20081, activatedAt: null }])
  })
})
