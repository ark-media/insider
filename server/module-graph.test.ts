// Guards the one property of the API's module graph that nothing else can see.
//
// `package.json` is `type: module`, and Vercel transpiles every `.ts` in the
// function to ESM `.js` without rewriting import specifiers. Node ESM does no
// extension guessing, so a relative import without an explicit `.js` throws
// ERR_MODULE_NOT_FOUND at module load — and since the whole API is one function
// (`api/handler.ts`), that takes down *every* route, not just the one that
// pulled the file in.
//
// Local `tsc -b` runs `moduleResolution: "bundler"` and cannot flag this; the
// only signal is a NON-FATAL `TS2835` line in Vercel's build log, so the deploy
// goes green and then 500s. That is exactly how it shipped once: server code
// reached into `src/data/shows.ts` for the paid-audio gate, and that file — Vite
// source, written in Vite's extensionless style — imported `"../config/urls"`.
//
// So walk the real graph from the real entrypoint and assert the ESM rule. The
// walk crosses into `src/` and `shared/` deliberately: those files are written
// for the bundler, and the moment one is imported for its *value* it has to obey
// the server's rules instead. (Type-only imports are erased at emit and can't
// fail at runtime, but they are held to the same rule — an `import type` becomes
// a value import the day someone needs the value, and that edit should not be
// the thing that breaks production.)

import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const ENTRY = join(ROOT, 'api/handler.ts')

// `from './x.js'`, side-effect `import './x.js'`, and `import('./x.js')`. Bare
// specifiers (npm packages, `node:` builtins) fall out in the caller — only
// relative ones are ours to get right.
const SPECIFIER_PATTERNS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function specifiersOf(source: string): string[] {
  const found = new Set<string>()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const [, spec] of source.matchAll(pattern)) {
      if (spec?.startsWith('.')) found.add(spec)
    }
  }
  return [...found]
}

// Mirror of what the build does: a `.js` specifier is written against the
// emitted output, so on disk it's the `.ts` (or `.tsx`) source. Extensionless
// specifiers resolve too — the point is to keep walking past a violation and
// report the whole set at once, not to stop at the first one.
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = join(dirname(fromFile), spec)
  const candidates = spec.endsWith('.js')
    ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base]
    : [`${base}.ts`, `${base}.tsx`, base, join(base, 'index.ts')]
  return candidates.find((c) => existsSync(c) && !c.endsWith('/')) ?? null
}

type Violation = { file: string; spec: string }

function walk(): { files: string[]; extensionless: Violation[]; missing: Violation[] } {
  const seen = new Set<string>([ENTRY])
  const queue = [ENTRY]
  const extensionless: Violation[] = []
  const missing: Violation[] = []

  while (queue.length > 0) {
    const file = queue.shift()!
    const source = readFileSync(file, 'utf8')
    for (const spec of specifiersOf(source)) {
      const where = { file: relative(ROOT, file), spec }
      if (!spec.endsWith('.js')) extensionless.push(where)
      const target = resolveSpecifier(file, spec)
      if (!target) {
        missing.push(where)
        continue
      }
      if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }

  return { files: [...seen].map((f) => relative(ROOT, f)), extensionless, missing }
}

describe('api/handler.ts module graph', () => {
  const graph = walk()

  test('reaches the routes it is supposed to', () => {
    // A guard that silently walked nothing would pass every other assertion
    // here, so pin a floor and a couple of the files that must be in the graph.
    expect(graph.files).toContain('server/dev-api.ts')
    expect(graph.files).toContain('server/routes/podcasts.ts')
    expect(graph.files).toContain('src/data/shows.ts')
    expect(graph.files.length).toBeGreaterThan(50)
  })

  test('every relative import carries an explicit .js extension', () => {
    expect(graph.extensionless).toEqual([])
  })

  test('every relative import resolves to a file that exists', () => {
    expect(graph.missing).toEqual([])
  })

  test('never pulls a .tsx file into the function', () => {
    // Components are for the browser: one in this graph means the lambda is
    // loading JSX and React, which is a bundle and a runtime it has no use for.
    expect(graph.files.filter((f) => f.endsWith('.tsx'))).toEqual([])
  })
})
