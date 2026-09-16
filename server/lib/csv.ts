// Minimal RFC-4180 CSV serializer. Every field is quoted and embedded quotes
// are doubled, so commas, quotes, and newlines in free-text (notes, emails)
// can't break out of their column. Rows are joined with CRLF and the output is
// prefixed with a UTF-8 BOM so Excel opens non-ASCII content correctly.

const BOM = '\uFEFF'

// Characters that make a spreadsheet treat a cell as a formula rather than
// text. RFC-4180 quoting does NOT protect against this: Excel and Sheets strip
// the quotes while parsing, then evaluate what's left. Our exports carry member
// free-text (the cancellation `note`) and member-chosen emails, so an attacker
// picks the cell contents and the admin opening the file runs it \u2014 that's how
// =WEBSERVICE(...) exfiltrates the rest of the sheet.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/

export function toCsv(headers: string[], rows: string[][]): string {
  // Prefix a single quote so the cell is forced to text. Spreadsheets consume
  // the quote on open, so the value still reads as the original string.
  const neutralize = (value: string) =>
    FORMULA_TRIGGER.test(value) ? `'${value}` : value
  const escape = (value: string) => `"${neutralize(value).replace(/"/g, '""')}"`
  const render = (row: string[]) => row.map(escape).join(',')
  return BOM + [headers, ...rows].map(render).join('\r\n')
}
