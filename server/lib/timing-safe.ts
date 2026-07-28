import crypto from 'node:crypto'

// Constant-time secret comparison. `timingSafeEqual` throws on length-mismatched
// buffers, so the length guard is required — and it short-circuits safely: a
// wrong-length secret is already distinguishable by the caller's rejection, so
// leaking "wrong length" via timing gives an attacker nothing the equal-length
// comparison doesn't. Server-only (webhook `?key=` secrets, the cron Bearer).
export function secretEquals(got: string, want: string): boolean {
  // An empty expected secret must never match. Every caller already refuses to
  // run when its secret env var is unset, but without this guard
  // secretEquals('', '') is true — so a single missing guard anywhere would turn
  // an unconfigured webhook into an open endpoint. Fail closed at the primitive.
  if (!want) return false
  const a = Buffer.from(got)
  const b = Buffer.from(want)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
