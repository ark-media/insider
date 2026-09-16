// Unit tests for the shared cancellation validators. Pure — the same predicates
// run on the client (survey form) and server (route handlers), so the reason
// list can't drift between them.

import { describe, test, expect } from 'bun:test'
import {
  CANCELLATION_REASONS,
  OTHER_REASON_SLUG,
  isCancellationReason,
  isCancellationReasons,
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
