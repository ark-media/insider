import { afterAll, beforeEach } from 'bun:test'

/**
 * Silences console.error/warn for the calling test file. Several suites
 * deliberately drive error and fallback paths (upstream 500s, missing config)
 * whose handlers log via console.error/warn — expected behavior, but it dumps
 * stack traces into an otherwise-green run. Call once at module scope; it
 * registers its own beforeEach/afterAll so the originals are restored after the
 * file finishes (other test files keep their console intact).
 */
export function silenceExpectedConsole() {
  const originalError = console.error
  const originalWarn = console.warn
  beforeEach(() => {
    console.error = () => {}
    console.warn = () => {}
  })
  afterAll(() => {
    console.error = originalError
    console.warn = originalWarn
  })
}
