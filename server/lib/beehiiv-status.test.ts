import { describe, expect, test } from 'bun:test'
import { mailableStatus, redactEmailsInText } from './beehiiv-status'

describe('redactEmailsInText', () => {
  test('masks every address in an upstream body, wherever it appears', () => {
    const body =
      '{"errors":[{"message":"jane.doe@example.com is invalid"},' +
      '{"detail":"<bob@ark.org> already exists"}]}'
    const out = redactEmailsInText(body)
    expect(out).not.toContain('jane.doe@example.com')
    expect(out).not.toContain('bob@ark.org')
    expect(out).toContain('j***@example.com')
    expect(out).toContain('b***@ark.org')
    // The rest of the message survives for diagnosis.
    expect(out).toContain('already exists')
  })

  test('text with no address is unchanged', () => {
    expect(redactEmailsInText('{"error":"rate limited"}')).toBe('{"error":"rate limited"}')
  })
})

describe('mailableStatus', () => {
  test("the 'deleted' tombstone is never mailed", () => {
    expect(mailableStatus('deleted')).toBe(false)
  })
})
