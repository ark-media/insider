// Defensive date normalization for upstream-provider responses.
//
// Beehiiv and Circle each have their own date conventions —
// Beehiiv sometimes returns unix seconds, Circle returns ISO strings (mostly
// well-formed). Rather than `.slice(0, 10)` on a
// string we can't fully trust, we round-trip through Date and reject NaN.
//
// Returns 'YYYY-MM-DD' or null when the input doesn't parse.

export function toIsoDate(
  input: string | number | null | undefined,
): string | null {
  if (input === null || input === undefined) return null
  if (typeof input === 'number') {
    // Heuristic: epochs < 10^11 are seconds (anything before 5138), >= are ms.
    const ms = input < 1e11 ? input * 1000 : input
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString().slice(0, 10)
  }
  if (typeof input !== 'string' || !input.trim()) return null
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}
