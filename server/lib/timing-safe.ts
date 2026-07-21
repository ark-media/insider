import crypto from 'node:crypto'

// Constant-time secret comparison. `timingSafeEqual` throws on length-mismatched
// buffers, so the length guard is required — and it short-circuits safely: a
// wrong-length secret is already distinguishable by the caller's rejection, so
// leaking "wrong length" via timing gives an attacker nothing the equal-length
// comparison doesn't. Server-only (webhook `?key=` secrets, the cron Bearer).
export function secretEquals(got: string, want: string): boolean {
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
