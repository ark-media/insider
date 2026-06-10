// Minimal RFC-4180 CSV serializer. Every field is quoted and embedded quotes
// are doubled, so commas, quotes, and newlines in free-text (notes, emails)
// can't break out of their column. Rows are joined with CRLF and the output is
// prefixed with a UTF-8 BOM so Excel opens non-ASCII content correctly.

const BOM = '\uFEFF'

export function toCsv(headers: string[], rows: string[][]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`
  const render = (row: string[]) => row.map(escape).join(',')
  return BOM + [headers, ...rows].map(render).join('\r\n')
}
