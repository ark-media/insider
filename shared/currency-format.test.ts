// One formatter for both halves of the app. The site and the emails quote the
// same prices; before this module they formatted them differently, so a
// Canadian member read "$25 a year" in the confirm panel and "CA$25 a year" in
// the email that followed it minutes later.

import { describe, expect, test } from 'bun:test'
import { formatCurrencyMajor } from './currency-format'

describe('formatCurrencyMajor', () => {
  test('a round amount reads as a sentence, not a receipt', () => {
    expect(formatCurrencyMajor(25, 'usd')).toBe('$25')
    expect(formatCurrencyMajor(8.5, 'usd')).toBe('$8.50')
  })

  test('the narrow symbol, so a member billed in their own currency sees "$"', () => {
    // The divergence this module exists to end: the server used to render these
    // as "CA$25" / "A$25" while the site rendered them as "$25".
    expect(formatCurrencyMajor(25, 'cad')).toBe('$25')
    expect(formatCurrencyMajor(25, 'aud')).toBe('$25')
  })

  test('case-insensitive on the ISO code', () => {
    expect(formatCurrencyMajor(25, 'EUR')).toBe(formatCurrencyMajor(25, 'eur'))
  })

  test('zero-decimal currencies keep their own shape', () => {
    expect(formatCurrencyMajor(21_125, 'jpy')).toBe('¥21,125')
  })

  test('English-only, whatever the host locale is', () => {
    // Pinned to 'en-US' for the same reason shared/format-date.ts pins dates: a
    // viewer in de-DE reading English copy should not meet "25,00 $" inside it.
    expect(formatCurrencyMajor(1234.5, 'eur')).toBe('€1,234.50')
  })

  test('an unusable code degrades to something readable rather than throwing', () => {
    // A bad currency must not take a price line — or the email around it — down.
    expect(formatCurrencyMajor(25, 'not-a-currency')).toBe('25 NOT-A-CURRENCY')
  })
})
