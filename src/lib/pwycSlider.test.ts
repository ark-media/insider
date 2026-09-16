import { describe, expect, test } from 'bun:test'
import {
  SLIDER_STEPS,
  amountFromPos,
  niceNumber,
  posFromAmount,
  snapStep,
} from './pwycSlider'

describe('niceNumber', () => {
  test('rounds to a 1/2/5 × 10ⁿ increment', () => {
    expect(niceNumber(1)).toBe(1)
    expect(niceNumber(1.4)).toBe(1)
    expect(niceNumber(2)).toBe(2)
    expect(niceNumber(4)).toBe(5)
    expect(niceNumber(8)).toBe(10)
    expect(niceNumber(40)).toBe(50)
    expect(niceNumber(830)).toBe(1000)
  })

  test('never returns below 1 for non-positive input', () => {
    expect(niceNumber(0)).toBe(1)
    expect(niceNumber(-5)).toBe(1)
  })
})

describe('snapStep', () => {
  test('is ~1/26 of the floor, snapped to a nice increment', () => {
    expect(snapStep(130)).toBe(5) // $130 → 5
    expect(snapStep(486)).toBe(20) // ₪486 → 20
    expect(snapStep(21125)).toBe(1000) // ¥21,125 → 1000
  })

  test('never drops below one whole unit', () => {
    expect(snapStep(1)).toBe(1)
    expect(snapStep(0)).toBe(1)
  })
})

describe('amountFromPos / posFromAmount', () => {
  const floor = 130
  const max = floor * 27 // 3510
  const step = snapStep(floor) // 5

  test('endpoints are exact', () => {
    expect(amountFromPos(0, floor, max, step)).toBe(floor)
    expect(amountFromPos(SLIDER_STEPS, floor, max, step)).toBe(max)
    expect(posFromAmount(floor, floor, max)).toBe(0)
    expect(posFromAmount(max, floor, max)).toBe(SLIDER_STEPS)
  })

  test('snapped amounts stay within [floor, max]', () => {
    for (let pos = 0; pos <= SLIDER_STEPS; pos += 37) {
      const a = amountFromPos(pos, floor, max, step)
      expect(a).toBeGreaterThanOrEqual(floor)
      expect(a).toBeLessThanOrEqual(max)
    }
  })

  test('amounts are multiples of the step (except the exact max endpoint)', () => {
    for (let pos = 0; pos < SLIDER_STEPS; pos += 53) {
      const a = amountFromPos(pos, floor, max, step)
      expect(a % step).toBe(0)
    }
  })

  test('is monotonic — higher position never yields a smaller amount', () => {
    let prev = -Infinity
    for (let pos = 0; pos <= SLIDER_STEPS; pos += 10) {
      const a = amountFromPos(pos, floor, max, step)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })

  test('posFromAmount round-trips a snapped amount back to a near position', () => {
    // amountFromPos snaps, so the exact position isn't recoverable, but the
    // inverse should land within one snap window of the original amount.
    for (let pos = 100; pos < SLIDER_STEPS; pos += 100) {
      const a = amountFromPos(pos, floor, max, step)
      const roundTrip = amountFromPos(
        posFromAmount(a, floor, max),
        floor,
        max,
        step,
      )
      expect(Math.abs(roundTrip - a)).toBeLessThanOrEqual(step)
    }
  })

  test('posFromAmount clamps out-of-range amounts (typed above the drag ceiling peg right)', () => {
    expect(posFromAmount(max * 10, floor, max)).toBe(SLIDER_STEPS)
    expect(posFromAmount(floor / 2, floor, max)).toBe(0)
  })

  test('degenerate range (max <= floor) pins the thumb at 0', () => {
    expect(posFromAmount(500, 130, 130)).toBe(0)
  })
})
