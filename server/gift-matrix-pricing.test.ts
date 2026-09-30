// Membership Change Matrix B2 — gift price rule.
//
//   6 months = the tier's monthly price ×6
//   1 year   = the tier's yearly price (monthly ×10, the subscription 10:1 anchor)
//
// scripts/stripe-catalog.ts provisions the gift Prices, but it calls main() at
// import time (Stripe writes) and exports nothing. So the pure catalog sections
// ("Catalog definition" + "Gift catalog", which have no imports or IO) are cut
// out of the source, transpiled, and evaluated in isolation — the real
// giftPricesFor / pricesFor run, not a copy. The USD table below is the one
// src/lib/gift.test.ts pins GIFT_PRICE_DOLLARS (the /subscribe/gift display copy) to;
// src/ is browser code, so it isn't imported into the server type-check here.

import { describe, expect, test } from 'bun:test'

type Amounts = Record<string, number>
type PriceDef = { lookup_key: string; interval: 'month' | 'year' | undefined; amounts: Amounts }
type Catalog = {
  CATALOG: Array<{ catalogKey: string; usdMonthlyMinor: number }>
  GIFT_CATALOG: Array<{ catalogKey: string; tierCatalogKey: string }>
  GIFT_TERM_MULTIPLE: Record<'6mo' | '1yr', number>
  pricesFor: (def: Catalog['CATALOG'][number]) => PriceDef[]
  giftPricesFor: (def: Catalog['GIFT_CATALOG'][number]) => PriceDef[]
  giftAmountsFor: (tierMonthlyUsdMinor: number, multiple: number) => Amounts
}

async function loadCatalog(): Promise<Catalog> {
  const src = await Bun.file(new URL('../scripts/stripe-catalog.ts', import.meta.url)).text()
  const start = src.indexOf('// --- Catalog definition')
  const end = src.indexOf('// --- Guards')
  if (start < 0 || end < 0) throw new Error('stripe-catalog.ts section markers moved')
  const section = src.slice(start, end)
  if (/^\s*import\s/m.test(section)) throw new Error('catalog section is no longer standalone')
  const js = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false }).transformSync(section)
  return new Function(
    `${js}\nreturn { CATALOG, GIFT_CATALOG, GIFT_TERM_MULTIPLE, pricesFor, giftPricesFor, giftAmountsFor }`,
  )() as Catalog
}

const catalog = await loadCatalog()

// What the gift page shows, in USD dollars (src/lib/gift.ts GIFT_PRICE_DOLLARS).
const DISPLAYED_USD: Record<string, Record<'6mo' | '1yr', number>> = {
  ark_plus: { '6mo': 48, '1yr': 80 },
  circle: { '6mo': 114, '1yr': 190 },
  bundle: { '6mo': 150, '1yr': 250 },
}

function subPrice(catalogKey: string, interval: 'month' | 'year'): PriceDef {
  const def = catalog.CATALOG.find((d) => d.catalogKey === catalogKey)!
  return catalog.pricesFor(def).find((p) => p.interval === interval)!
}

function giftPrice(tierCatalogKey: string, term: '6mo' | '1yr'): PriceDef {
  const def = catalog.GIFT_CATALOG.find((d) => d.tierCatalogKey === tierCatalogKey)!
  return catalog.giftPricesFor(def).find((p) => p.lookup_key.endsWith(`_${term}`))!
}

describe('B2 — gift price rule (scripts/stripe-catalog.ts)', () => {
  test('term multiples: 6mo = monthly ×6, 1yr = monthly ×10', () => {
    expect(catalog.GIFT_TERM_MULTIPLE).toEqual({ '6mo': 6, '1yr': 10 })
  })

  test('every gift product mirrors a subscription tier', () => {
    expect(catalog.GIFT_CATALOG.map((g) => g.tierCatalogKey).sort()).toEqual([
      'ark_plus',
      'bundle',
      'circle',
    ])
  })

  for (const tierKey of ['ark_plus', 'circle', 'bundle']) {
    test(`${tierKey}: 6mo gift USD = monthly ×6`, () => {
      expect(giftPrice(tierKey, '6mo').amounts.usd).toBe(subPrice(tierKey, 'month').amounts.usd * 6)
    })

    test(`${tierKey}: 1yr gift USD = the yearly subscription price, to the cent`, () => {
      expect(giftPrice(tierKey, '1yr').amounts.usd).toBe(subPrice(tierKey, 'year').amounts.usd)
    })

    test(`${tierKey}: 1yr gift = yearly price in every currency`, () => {
      // Same base × scale × 10 on both sides, so the localized amounts agree too.
      expect(giftPrice(tierKey, '1yr').amounts).toEqual(subPrice(tierKey, 'year').amounts)
    })

    test(`${tierKey}: gift prices are one-time (no interval), lookup-keyed gift_<tier>_<term>`, () => {
      expect(giftPrice(tierKey, '6mo').interval).toBeUndefined()
      expect(giftPrice(tierKey, '6mo').lookup_key).toBe(`gift_${tierKey}_6mo`)
      expect(giftPrice(tierKey, '1yr').lookup_key).toBe(`gift_${tierKey}_1yr`)
    })
  }

  test('giftAmountsFor: USD is exact (monthly × multiple), never a rounded scale', () => {
    expect(catalog.giftAmountsFor(1900, 6).usd).toBe(11_400)
    expect(catalog.giftAmountsFor(2500, 10).usd).toBe(25_000)
  })
})

describe('B2 — the provisioned USD gift prices are the ones the gift page shows', () => {
  for (const [tierKey, shown] of Object.entries(DISPLAYED_USD)) {
    test(`${tierKey}: $${shown['6mo']} for 6 months, $${shown['1yr']} for a year`, () => {
      expect(giftPrice(tierKey, '6mo').amounts.usd).toBe(shown['6mo'] * 100)
      expect(giftPrice(tierKey, '1yr').amounts.usd).toBe(shown['1yr'] * 100)
    })
  }
})
