import { describe, expect, test } from 'bun:test'
import { decimalsForFactor, toMajor, toMinor } from './currency'

describe('minor-unit conversion', () => {
  test('two-decimal currencies use a factor of 100', () => {
    // $300.00 → 30000 minor units, and back.
    expect(toMinor(300, 100)).toBe(30000)
    expect(toMajor(30000, 100)).toBe(300)
    // ₪485.88 → 48588.
    expect(toMinor(485.88, 100)).toBe(48588)
    expect(toMajor(48588, 100)).toBe(485.88)
  })

  test('zero-decimal currencies use a factor of 1 (no ×100)', () => {
    // The regression this guards: ¥82,000 must send 82000, NOT 8,200,000.
    expect(toMinor(82000, 1)).toBe(82000)
    expect(toMajor(82000, 1)).toBe(82000)
  })

  test('toMinor rounds to a whole minor unit', () => {
    expect(toMinor(10.005, 100)).toBe(1001)
    expect(toMinor(10.004, 100)).toBe(1000)
  })

  test('decimalsForFactor reflects the currency shape', () => {
    expect(decimalsForFactor(100)).toBe(2)
    expect(decimalsForFactor(1)).toBe(0)
  })
})
