// Map a buyer's country (from the platform geo header) to a default presentment
// currency. This only picks the *default* — the client always offers a manual
// selector, and any country not mapped here falls back to USD. Every value must
// be one of SUPPORTED_CURRENCIES (server/lib/pricing.ts).

import type { IncomingMessage } from 'node:http'
import { isSupportedCurrency, type SupportedCurrency } from './pricing.js'

// ISO 3166-1 alpha-2 country → currency. Grouped by currency; eurozone (and the
// countries that use the euro) all map to EUR. Countries absent here default to
// USD in currencyForCountry.
const COUNTRY_TO_CURRENCY: Record<string, SupportedCurrency> = {
  US: 'usd',
  GB: 'gbp',
  // Eurozone + euro-using microstates/territories
  AT: 'eur', BE: 'eur', CY: 'eur', EE: 'eur', FI: 'eur', FR: 'eur', DE: 'eur',
  GR: 'eur', IE: 'eur', IT: 'eur', LV: 'eur', LT: 'eur', LU: 'eur', MT: 'eur',
  NL: 'eur', PT: 'eur', SK: 'eur', SI: 'eur', ES: 'eur', AD: 'eur', MC: 'eur',
  SM: 'eur', VA: 'eur', ME: 'eur', XK: 'eur',
  CA: 'cad',
  CZ: 'czk',
  DK: 'dkk',
  HU: 'huf',
  NO: 'nok',
  PL: 'pln',
  RO: 'ron',
  RU: 'rub',
  SE: 'sek',
  CH: 'chf', LI: 'chf',
  AU: 'aud',
  HK: 'hkd',
  ID: 'idr',
  JP: 'jpy',
  KZ: 'kzt',
  KR: 'krw',
  MY: 'myr',
  NZ: 'nzd',
  PH: 'php',
  SG: 'sgd',
  TW: 'twd',
  TH: 'thb',
  VN: 'vnd',
  EG: 'egp',
  IN: 'inr',
  IL: 'ils',
  NG: 'ngn',
  QA: 'qar',
  SA: 'sar',
  ZA: 'zar',
  TZ: 'tzs',
  AE: 'aed',
  BR: 'brl',
  CL: 'clp',
  CO: 'cop',
  MX: 'mxn',
  PE: 'pen',
}

// Default presentment currency for a country code, USD when unknown/unmapped.
export function currencyForCountry(country: string | undefined): SupportedCurrency {
  if (!country) return 'usd'
  const cur = COUNTRY_TO_CURRENCY[country.toUpperCase()]
  return cur && isSupportedCurrency(cur) ? cur : 'usd'
}

// The buyer's country from the platform geo header. Vercel sets
// `x-vercel-ip-country`; Cloudflare sets `cf-ipcountry`. Returns undefined when
// neither is present (e.g. local dev), so the caller falls back to USD.
export function countryFromRequest(req: IncomingMessage): string | undefined {
  const header = (name: string): string | undefined => {
    const v = req.headers[name]
    return Array.isArray(v) ? v[0] : v
  }
  const raw = header('x-vercel-ip-country') ?? header('cf-ipcountry')
  const country = raw?.trim().toUpperCase()
  // Cloudflare uses "XX" for unknown; treat as absent.
  return country && country !== 'XX' ? country : undefined
}
