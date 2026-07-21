import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { countryFromRequest, currencyForCountry } from './lib/geo-currency.js'

describe('currencyForCountry', () => {
  test('maps primary markets to their currency', () => {
    expect(currencyForCountry('US')).toBe('usd')
    expect(currencyForCountry('GB')).toBe('gbp')
    expect(currencyForCountry('JP')).toBe('jpy')
    expect(currencyForCountry('IL')).toBe('ils')
    expect(currencyForCountry('BR')).toBe('brl')
  })

  test('maps eurozone countries to eur', () => {
    for (const c of ['DE', 'FR', 'IT', 'ES', 'NL', 'IE']) {
      expect(currencyForCountry(c)).toBe('eur')
    }
  })

  test('is case-insensitive', () => {
    expect(currencyForCountry('gb')).toBe('gbp')
  })

  test('falls back to usd for unknown / undefined', () => {
    expect(currencyForCountry('ZZ')).toBe('usd')
    expect(currencyForCountry(undefined)).toBe('usd')
    expect(currencyForCountry('')).toBe('usd')
  })
})

describe('countryFromRequest', () => {
  const reqWith = (headers: Record<string, string | string[]>) =>
    ({ headers }) as unknown as IncomingMessage

  test('reads the Vercel geo header', () => {
    expect(countryFromRequest(reqWith({ 'x-vercel-ip-country': 'GB' }))).toBe('GB')
  })

  test('falls back to the Cloudflare header', () => {
    expect(countryFromRequest(reqWith({ 'cf-ipcountry': 'jp' }))).toBe('JP')
  })

  test('treats Cloudflare "XX" (unknown) as absent', () => {
    expect(countryFromRequest(reqWith({ 'cf-ipcountry': 'XX' }))).toBeUndefined()
  })

  test('returns undefined with no geo header (local dev)', () => {
    expect(countryFromRequest(reqWith({}))).toBeUndefined()
  })
})
