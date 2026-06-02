// Unit tests for the new-content notification orchestration. Fakes for every
// port — no live Simplecast / Circle / Stripe / Resend.

import { describe, test, expect } from 'bun:test'
import {
  runContentNotifications,
  type ContentItem,
  type ContentKind,
  type NotifyPorts,
} from './notify-content.js'

function item(id: string, publishedAt: string): ContentItem {
  return { id, title: `Item ${id}`, url: `https://x/${id}`, publishedAt }
}

type Sent = { to: string; kind: ContentKind; id: string }

function makePorts(opts: {
  episodes?: ContentItem[]
  posts?: ContentItem[]
  seen?: Partial<Record<ContentKind, string[]>>
  members?: string[]
  optedOut?: Partial<Record<ContentKind, string[]>>
  failSendTo?: string
}) {
  const seen: Record<ContentKind, Set<string>> = {
    episode: new Set(opts.seen?.episode ?? []),
    post: new Set(opts.seen?.post ?? []),
  }
  const sent: Sent[] = []
  const ports: NotifyPorts = {
    listItems: (k) =>
      Promise.resolve((k === 'episode' ? opts.episodes : opts.posts) ?? []),
    getSeen: (k) => Promise.resolve(new Set(seen[k])),
    markSeen: (k, ids) => {
      ids.forEach((id) => seen[k].add(id))
      return Promise.resolve()
    },
    listMemberEmails: () => Promise.resolve(opts.members ?? []),
    getOptedOut: (k) => Promise.resolve(new Set(opts.optedOut?.[k] ?? [])),
    send: (to, kind, it) => {
      if (to === opts.failSendTo) return Promise.resolve(false)
      sent.push({ to, kind, id: it.id })
      return Promise.resolve(true)
    },
  }
  return { ports, seen, sent }
}

describe('runContentNotifications', () => {
  test('first run seeds the ledger and sends nothing', async () => {
    const { ports, seen, sent } = makePorts({
      episodes: [item('e1', '2026-01-01'), item('e2', '2026-01-02')],
      posts: [item('p1', '2026-01-01')],
      members: ['a@x.com'],
      seen: {}, // empty ledger → first run
    })
    const res = await runContentNotifications(ports)
    expect(sent).toHaveLength(0)
    expect(res.find((r) => r.kind === 'episode')?.seeded).toBe(true)
    // Catalogue adopted as baseline.
    expect(seen.episode).toEqual(new Set(['e1', 'e2']))
    expect(seen.post).toEqual(new Set(['p1']))
  })

  test('sends only genuinely new items to all opted-in members', async () => {
    const { ports, sent } = makePorts({
      episodes: [item('e1', '2026-01-01'), item('e2', '2026-01-02')],
      seen: { episode: ['e1'], post: ['seed'] }, // e1 already sent
      members: ['a@x.com', 'b@x.com'],
    })
    await runContentNotifications(ports)
    const eps = sent.filter((s) => s.kind === 'episode')
    expect(eps).toHaveLength(2) // e2 × 2 members
    expect(eps.every((s) => s.id === 'e2')).toBe(true)
    expect(new Set(eps.map((s) => s.to))).toEqual(new Set(['a@x.com', 'b@x.com']))
  })

  test('excludes members who opted out of that kind', async () => {
    const { ports, sent } = makePorts({
      posts: [item('p2', '2026-02-01')],
      seen: { episode: ['seed'], post: ['p1'] },
      members: ['a@x.com', 'b@x.com'],
      optedOut: { post: ['b@x.com'] },
    })
    await runContentNotifications(ports)
    const posts = sent.filter((s) => s.kind === 'post')
    expect(posts.map((s) => s.to)).toEqual(['a@x.com'])
  })

  test('opt-out matching is case-insensitive on the member list', async () => {
    const { ports, sent } = makePorts({
      posts: [item('p2', '2026-02-01')],
      seen: { episode: ['seed'], post: ['p1'] },
      members: ['Mixed@X.com'],
      optedOut: { post: ['mixed@x.com'] }, // stored lowercased
    })
    await runContentNotifications(ports)
    expect(sent).toHaveLength(0)
  })

  test('records an item as seen even after a partial send failure', async () => {
    const { ports, seen, sent } = makePorts({
      episodes: [item('e2', '2026-01-02')],
      seen: { episode: ['e1'], post: ['seed'] },
      members: ['a@x.com', 'b@x.com'],
      failSendTo: 'a@x.com',
    })
    const res = await runContentNotifications(ports)
    expect(seen.episode.has('e2')).toBe(true) // marked despite the failure
    expect(sent.filter((s) => s.id === 'e2')).toHaveLength(1) // only b@x.com
    expect(res.find((r) => r.kind === 'episode')?.sent).toBe(1)
  })

  test('no new items → no sends, not seeded', async () => {
    const { ports, sent } = makePorts({
      episodes: [item('e1', '2026-01-01')],
      seen: { episode: ['e1'], post: ['p1'] },
      posts: [item('p1', '2026-01-01')],
      members: ['a@x.com'],
    })
    const res = await runContentNotifications(ports)
    expect(sent).toHaveLength(0)
    expect(res.every((r) => !r.seeded && r.newItems === 0)).toBe(true)
  })
})
