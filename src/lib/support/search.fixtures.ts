// The live FAQ corpus, parsed out of the migrations at test time.
//
// Test-only (imported by search.test.ts, never by the app). Parsed rather than
// transcribed so there is no second copy of 33 questions to drift: if someone
// lands a new content migration, these fixtures follow it and the golden set
// fails loudly instead of quietly testing yesterday's corpus.
//
// Content comes from the newest migration that reseeds `faqs`; keys come from
// the newest one that backfills `faqs.key`. Any later migration that rewrites
// rows BY KEY (the Fold rename, 0021) is then replayed on top, in file order —
// otherwise a corpus edit that doesn't reseed the whole table would leave these
// fixtures testing copy the database no longer holds.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Faq } from '../faqs'

const MIGRATIONS = join(import.meta.dir, '../../../migrations')

/**
 * Drops whole-line SQL comments. Necessary, not tidiness: these migrations
 * document their own dollar-quoting in the header ("Dollar-quoted literals
 * ($Q$...$Q$) so apostrophes don't need escaping"), and that example otherwise
 * matches the row regex and swallows the file up to the first real row.
 */
function stripSqlComments(sql: string): string {
  return sql.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n')
}

/** Every migration, oldest first, with its comment lines already stripped. */
function migrations(): Array<{ file: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8')) }))
}

function newestMatching(pattern: RegExp): { file: string; sql: string } {
  const hit = migrations().reverse().find((m) => pattern.test(m.sql))
  if (!hit) throw new Error(`No migration matching ${pattern}`)
  return hit
}

/** display_order, $C$category$C$, $Q$question$Q$, $A$answer$A$ */
const ROW = /\(\s*(\d+),\s*\$C\$([\s\S]*?)\$C\$,\s*\$Q\$([\s\S]*?)\$Q\$,\s*\$A\$([\s\S]*?)\$A\$\s*\)/g
/** ($Q$question$Q$, 'key') */
const KEY_ROW = /\(\s*\$Q\$([\s\S]*?)\$Q\$,\s*'([a-z0-9-]+)'\s*\)/g
/** ('key', $Q$question$Q$, $A$answer$A$) — a rewrite addressed by key. */
const REWRITE_ROW = /\(\s*'([a-z0-9-]+)',\s*\$Q\$([\s\S]*?)\$Q\$,\s*\$A\$([\s\S]*?)\$A\$\s*\)/g
const REWRITES_BY_KEY = /update faqs set question = v\.question, answer = v\.answer/

export function loadFaqFixtures(): Faq[] {
  const content = newestMatching(/insert into faqs \(display_order, category, question, answer\)/)
  const keySql = newestMatching(/update faqs set key = v\.key/)

  const keyByQuestion = new Map<string, string>()
  for (const m of keySql.sql.matchAll(KEY_ROW)) keyByQuestion.set(m[1], m[2])

  // Key-addressed rewrites landed after the reseed, replayed in file order so
  // the last edit to a row wins — the same order Postgres saw them in.
  const rewritten = new Map<string, { question: string; answer: string }>()
  for (const m of migrations()) {
    if (m.file <= content.file || !REWRITES_BY_KEY.test(m.sql)) continue
    for (const r of m.sql.matchAll(REWRITE_ROW)) {
      rewritten.set(r[1], { question: r[2], answer: r[3] })
    }
  }

  const faqs: Faq[] = []
  for (const m of content.sql.matchAll(ROW)) {
    const [, order, category, question, answer] = m
    const key = keyByQuestion.get(question) ?? null
    const edit = key ? rewritten.get(key) : undefined
    faqs.push({
      id: `fixture-${order}`,
      key,
      question: edit?.question ?? question,
      answer: edit?.answer ?? answer,
      category,
      enabled: true,
      displayOrder: Number(order),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  return faqs
}
