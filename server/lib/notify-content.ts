// Core "new content → email members" orchestration. Pure logic behind small
// injected ports so it's unit-testable without live Simplecast / Circle /
// Stripe / Resend. The cron route (notify-new-content.ts) wires the real
// adapters; tests pass fakes.
//
// Per content type ('episode' | 'post'):
//   1. List current items and the already-notified ids (the ledger).
//   2. First run for a type (ledger empty) → seed every current id, send
//      nothing. Stops a fresh deploy blasting the back catalogue.
//   3. Otherwise → for each item not in the ledger, email the opted-in member
//      audience (all active members minus those who toggled this kind off),
//      then record the id so the next run skips it.
//
// Dedup is per-item, recorded only after a successful pass, so a crash mid-run
// re-attempts rather than silently dropping an item.

export type ContentKind = 'episode' | 'post'

export type ContentItem = {
  /** Stable id from the upstream source; the ledger key. */
  id: string
  title: string
  url: string
  /** ISO date, used only for ordering/most-recent selection. */
  publishedAt: string
}

export type NotifyPorts = {
  listItems: (kind: ContentKind) => Promise<ContentItem[]>
  /** Already-notified ids for a kind (the ledger). */
  getSeen: (kind: ContentKind) => Promise<Set<string>>
  /** Record ids as notified (idempotent upsert). */
  markSeen: (kind: ContentKind, ids: string[]) => Promise<void>
  /** Active member emails (lowercased). */
  listMemberEmails: () => Promise<string[]>
  /** Members who toggled this kind off (lowercased). */
  getOptedOut: (kind: ContentKind) => Promise<Set<string>>
  /** Send one notification. Returns whether it went out. */
  send: (to: string, kind: ContentKind, item: ContentItem) => Promise<boolean>
}

export type KindResult = {
  kind: ContentKind
  /** True when this run seeded the ledger instead of sending. */
  seeded: boolean
  newItems: number
  recipients: number
  sent: number
}

const KINDS: ContentKind[] = ['episode', 'post']

async function runKind(
  kind: ContentKind,
  ports: NotifyPorts,
): Promise<KindResult> {
  const items = await ports.listItems(kind)
  const seen = await ports.getSeen(kind)

  // First run for this type: adopt the current catalogue as the baseline so we
  // only ever notify about items published *after* the feature goes live.
  if (seen.size === 0) {
    if (items.length > 0) await ports.markSeen(kind, items.map((i) => i.id))
    return { kind, seeded: true, newItems: items.length, recipients: 0, sent: 0 }
  }

  const fresh = items.filter((i) => !seen.has(i.id))
  if (fresh.length === 0) {
    return { kind, seeded: false, newItems: 0, recipients: 0, sent: 0 }
  }

  const [members, optedOut] = await Promise.all([
    ports.listMemberEmails(),
    ports.getOptedOut(kind),
  ])
  const audience = members
    .map((e) => e.toLowerCase())
    .filter((e) => !optedOut.has(e))

  // Oldest first, so if several items are new at once members get them in
  // publish order.
  const ordered = [...fresh].sort((a, b) =>
    a.publishedAt.localeCompare(b.publishedAt),
  )

  let sent = 0
  for (const item of ordered) {
    for (const email of audience) {
      if (await ports.send(email, kind, item)) sent += 1
    }
    // Record per item: a failure on a later item still keeps the earlier ones
    // out of the next run.
    await ports.markSeen(kind, [item.id])
  }

  return {
    kind,
    seeded: false,
    newItems: fresh.length,
    recipients: audience.length,
    sent,
  }
}

export async function runContentNotifications(
  ports: NotifyPorts,
): Promise<KindResult[]> {
  const results: KindResult[] = []
  for (const kind of KINDS) {
    results.push(await runKind(kind, ports))
  }
  return results
}
