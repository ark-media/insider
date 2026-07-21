// Unit tests for findOrCreateScUser — in particular the create-race recovery.
//
// `ScClient` is just `{ call }`, so these tests drive it with a fake `call`
// that dispatches by path and can be scripted to fail. No live SC network.

import { describe, test, expect } from 'bun:test'
import { findOrCreateScUser, type ScClient } from './sc-client'

type CallArgs = [method: string, path: string, body?: unknown, opts?: unknown]

// Build a fake ScClient whose `call` is driven by a per-path handler. Records
// every call so tests can assert how many times /users was POSTed.
function fakeSc(handlers: {
  search: () => unknown
  createUser?: () => unknown
}): { sc: ScClient; calls: CallArgs[] } {
  const calls: CallArgs[] = []
  const call = (async (method: string, path: string, body?: unknown, opts?: unknown) => {
    calls.push([method, path, body, opts])
    if (path === '/users/search') return handlers.search()
    if (path === '/users') {
      if (!handlers.createUser) throw new Error(`unexpected POST /users`)
      return handlers.createUser()
    }
    throw new Error(`unhandled path ${path}`)
  }) as ScClient['call']
  return { sc: { call }, calls }
}

const duplicate409 = Object.assign(new Error('SC POST /users failed: 409'), {
  status: 409,
  data: { message: 'A user with this email or external ID already exists.', error: 'duplicate_user' },
})

describe('findOrCreateScUser', () => {
  test('returns the existing user without creating when search finds it', async () => {
    const existing = { id: 42, email: 'a@b.com' }
    const { sc, calls } = fakeSc({ search: () => ({ users: [existing] }) })

    const user = await findOrCreateScUser(sc, 'a@b.com')

    expect(user).toEqual(existing)
    // Only the search ran; no POST /users.
    expect(calls.map((c) => c[1])).toEqual(['/users/search'])
  })

  test('creates the user when search returns none', async () => {
    const created = { id: 99, email: 'new@b.com' }
    const { sc, calls } = fakeSc({
      search: () => ({ users: [] }),
      createUser: () => ({ user: created }),
    })

    const user = await findOrCreateScUser(sc, 'new@b.com')

    expect(user).toEqual(created)
    expect(calls.map((c) => c[1])).toEqual(['/users/search', '/users'])
  })

  test('recovers the existing user when POST /users 409s (create-race)', async () => {
    const raced = { id: 3287531, email: 'hannah@b.com' }
    let searchCount = 0
    const { sc, calls } = fakeSc({
      // First search misses (user not created yet); the re-search after the 409
      // finds the user the winning provisioner just created.
      search: () => {
        searchCount += 1
        return searchCount === 1 ? { users: [] } : { users: [raced] }
      },
      createUser: () => {
        throw duplicate409
      },
    })

    const user = await findOrCreateScUser(sc, 'hannah@b.com')

    expect(user).toEqual(raced)
    // search → POST /users (409) → re-search.
    expect(calls.map((c) => c[1])).toEqual(['/users/search', '/users', '/users/search'])
  })

  test('rethrows a 409 when the re-search still finds nothing', async () => {
    const { sc } = fakeSc({
      search: () => ({ users: [] }),
      createUser: () => {
        throw duplicate409
      },
    })

    await expect(findOrCreateScUser(sc, 'ghost@b.com')).rejects.toThrow('409')
  })

  test('rethrows non-409 create errors untouched', async () => {
    const boom = Object.assign(new Error('SC POST /users failed: 500'), { status: 500 })
    const { sc } = fakeSc({
      search: () => ({ users: [] }),
      createUser: () => {
        throw boom
      },
    })

    await expect(findOrCreateScUser(sc, 'err@b.com')).rejects.toThrow('500')
  })
})
