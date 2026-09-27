import { describe, expect, test } from 'bun:test'
import { renewalStatement } from './checkout-consent'

describe('renewalStatement', () => {
  test('charged today: the recurring amount and cadence', () => {
    expect(renewalStatement('$8.00', 'per month')).toBe(
      'I understand my subscription renews automatically at $8.00 per month until I cancel.',
    )
    expect(renewalStatement(null, 'per year')).toBe(
      'I understand my subscription renews automatically every year until I cancel.',
    )
  })

  test('billing that waits for a gift names the first charge date', () => {
    expect(renewalStatement('$8.00', 'per month', 'March 3, 2027')).toBe(
      'I understand my subscription starts charging $8.00 per month on March 3, 2027 and renews automatically until I cancel.',
    )
    expect(renewalStatement(null, 'per month', 'March 3, 2027')).toBe(
      'I understand my subscription starts charging on March 3, 2027 and renews automatically every month until I cancel.',
    )
  })
})
