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

  test.each<[string, Record<string, string | string[]>, string | undefined]>([
    ['reads the Vercel geo header', { 'x-vercel-ip-country': 'GB' }, 'GB'],
    ['falls back to the Cloudflare header', { 'cf-ipcountry': 'jp' }, 'JP'],
    ['treats Cloudflare "XX" (unknown) as absent', { 'cf-ipcountry': 'XX' }, undefined],
    ['returns undefined with no geo header (local dev)', {}, undefined],
  ])('%s', (_name, headers, expected) => {
    expect(countryFromRequest(reqWith(headers))).toBe(expected)
  })
})
