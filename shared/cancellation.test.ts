// Unit tests for the shared cancellation validators. Pure — the same predicates
// run on the client (survey form) and server (route handlers), so the reason
// list can't drift between them.

import { describe, test, expect } from 'bun:test'
import {
  CANCELLATION_REASONS,
  CANCELLATION_SURVEYS,
  OTHER_REASON_SLUG,
  isCancellationReason,
  isCancellationReasons,
  reasonLabel,
} from './cancellation'

describe('isCancellationReason', () => {
  test('accepts every slug in the canonical list', () => {
    for (const r of CANCELLATION_REASONS) {
      expect(isCancellationReason(r.slug)).toBe(true)
    }
  })

  test('rejects an unknown slug and non-strings', () => {
    expect(isCancellationReason('just_because')).toBe(false)
    expect(isCancellationReason('')).toBe(false)
    expect(isCancellationReason(null)).toBe(false)
    expect(isCancellationReason(undefined)).toBe(false)
    expect(isCancellationReason(42)).toBe(false)
    expect(isCancellationReason(['too_expensive'])).toBe(false)
  })

  test('OTHER_REASON_SLUG is itself a known slug', () => {
    expect(isCancellationReason(OTHER_REASON_SLUG)).toBe(true)
  })
})

describe('isCancellationReasons', () => {
  test('accepts an empty array (the survey is optional, shown post-cancel)', () => {
    expect(isCancellationReasons([])).toBe(true)
  })

  test('accepts an array of known slugs', () => {
    expect(isCancellationReasons(['too_expensive'])).toBe(true)
    expect(isCancellationReasons(['too_expensive', OTHER_REASON_SLUG])).toBe(true)
  })

  test('rejects an array containing any unknown slug', () => {
    expect(isCancellationReasons(['too_expensive', 'just_because'])).toBe(false)
    expect(isCancellationReasons(['just_because'])).toBe(false)
  })

  test('rejects non-array inputs (incl. a bare slug string)', () => {
    expect(isCancellationReasons('too_expensive')).toBe(false)
    expect(isCancellationReasons(null)).toBe(false)
    expect(isCancellationReasons(undefined)).toBe(false)
    expect(isCancellationReasons({ 0: 'too_expensive' })).toBe(false)
  })

  test('rejects an array with non-string members', () => {
    expect(isCancellationReasons(['too_expensive', 42])).toBe(false)
    expect(isCancellationReasons([null])).toBe(false)
  })
})

// The three per-tier surveys (Ark+, the Fold, the bundle). Every slug they show
// has to be one the server will accept, and a slug asked in more than one survey
// has to carry the same label everywhere it appears.
describe('CANCELLATION_SURVEYS', () => {
  const surveys = Object.entries(CANCELLATION_SURVEYS)

  test('covers each cancellable tier and each debundle', () => {
    expect(Object.keys(CANCELLATION_SURVEYS).sort()).toEqual([
      'ark-plus',
      'bundle',
      'circle',
      'debundle-remove-ark-plus',
      'debundle-remove-circle',
    ])
  })

  test.each(surveys)('%s asks only known, non-repeating slugs', (_tier, survey) => {
    const slugs = survey.groups.flatMap((g) => g.reasons.map((r) => r.slug))
    expect(slugs.length).toBeGreaterThan(0)
    expect(new Set(slugs).size).toBe(slugs.length)
    for (const slug of slugs) expect(isCancellationReason(slug)).toBe(true)
  })

  test.each(surveys)('%s offers "other" for the free-text note', (_tier, survey) => {
    const slugs = survey.groups.flatMap((g) => g.reasons.map((r) => r.slug))
    expect(slugs).toContain(OTHER_REASON_SLUG)
  })

  test.each(surveys)('%s opens with an unlabelled group', (_tier, survey) => {
    expect(survey.groups[0]?.question).toBeNull()
    expect(survey.heading).not.toBe('')
    expect(survey.prompt).not.toBe('')
  })

  test.each(surveys)('%s labels slugs as the shared list does', (_tier, survey) => {
    for (const group of survey.groups) {
      for (const r of group.reasons) expect(reasonLabel(r.slug)).toBe(r.label)
    }
  })

  test('the shared list is exactly what the surveys can store', () => {
    const asked = new Set(
      surveys.flatMap(([, survey]) =>
        survey.groups.flatMap((g) => g.reasons.map((r) => r.slug)),
      ),
    )
    expect([...asked].sort()).toEqual(
      CANCELLATION_REASONS.map((r) => r.slug).sort(),
    )
  })

  // A debundler is keeping half the membership, so the survey can't talk as if
  // they left, and it asks about the half they dropped — not the half they kept.
  test.each([
    ['debundle-remove-ark-plus', 'Ark+', 'finished_series', 'fold_low_usage'],
    ['debundle-remove-circle', 'The Fold', 'fold_low_usage', 'finished_series'],
  ] as const)(
    '%s asks about %s and never says "cancelled"',
    (key, product, dropped, kept) => {
      const survey = CANCELLATION_SURVEYS[key]
      expect(survey.heading).toContain(product)
      expect(survey.heading).not.toContain('cancelled')
      expect(survey.prompt).toContain(product)
      const slugs = survey.groups.flatMap((g) => g.reasons.map((r) => r.slug))
      expect(slugs).toContain(dropped)
      expect(slugs).not.toContain(kept)
      // The reason that says the bundle was mis-sold, not that a product fell
      // short — it leads both debundle surveys and appears in no other.
      expect(slugs[0]).toBe('only_wanted_one')
    },
  )

  test('only a debundle asks whether one part was ever wanted', () => {
    const asks = surveys
      .filter(([, s]) =>
        s.groups.some((g) => g.reasons.some((r) => r.slug === 'only_wanted_one')),
      )
      .map(([tier]) => tier)
      .sort()
    expect(asks).toEqual(['debundle-remove-ark-plus', 'debundle-remove-circle'])
  })

  test('dropping Ark+ does not ask a staying member about support', () => {
    // "…don't need an ongoing subscription" is false on its face for someone
    // who is keeping the Fold.
    const slugs = CANCELLATION_SURVEYS['debundle-remove-ark-plus'].groups.flatMap(
      (g) => g.reasons.map((r) => r.slug),
    )
    expect(slugs).not.toContain('support_only')
    expect(CANCELLATION_SURVEYS['ark-plus'].groups[0].reasons.map((r) => r.slug)).toContain(
      'support_only',
    )
  })

  test('the bundle splits the product questions out, Ark+/Fold do not', () => {
    expect(CANCELLATION_SURVEYS.bundle.groups.map((g) => g.question)).toEqual([
      null,
      'What made you decide to cancel Ark+?',
      'What made you decide to cancel The Fold?',
    ])
    expect(CANCELLATION_SURVEYS['ark-plus'].groups).toHaveLength(1)
    expect(CANCELLATION_SURVEYS.circle.groups).toHaveLength(1)
  })
})
