import { describe, test, expect } from 'bun:test'
import { createSingleFlight } from './single-flight'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSingleFlight', () => {
  test('concurrent calls for one key share a single load', async () => {
    const flight = createSingleFlight<string, number>()
    const gate = deferred<number>()
    let loads = 0
    const load = () => {
      loads++
      return gate.promise
    }
    const calls = Array.from({ length: 50 }, () => flight.run('k', load))
    gate.resolve(7)
    expect(await Promise.all(calls)).toEqual(Array(50).fill(7))
    expect(loads).toBe(1)
  })

  test('different keys load independently', async () => {
    const flight = createSingleFlight<string, string>()
    let loads = 0
    const [a, b] = await Promise.all([
      flight.run('a', async () => (loads++, 'A')),
      flight.run('b', async () => (loads++, 'B')),
    ])
    expect([a, b]).toEqual(['A', 'B'])
    expect(loads).toBe(2)
  })

  test('a settled load is forgotten, so the next call loads again', async () => {
    const flight = createSingleFlight<string, number>()
    let loads = 0
    await flight.run('k', async () => ++loads)
    expect(await flight.run('k', async () => ++loads)).toBe(2)
  })

  test('a rejection reaches every joined caller and is not remembered', async () => {
    const flight = createSingleFlight<string, number>()
    const gate = deferred<number>()
    const first = flight.run('k', () => gate.promise)
    const second = flight.run('k', async () => 99)
    gate.reject(new Error('upstream down'))
    await expect(first).rejects.toThrow('upstream down')
    await expect(second).rejects.toThrow('upstream down')
    expect(await flight.run('k', async () => 3)).toBe(3)
  })

  test('a synchronous throw becomes a rejection and is cleaned up', async () => {
    const flight = createSingleFlight<string, number>()
    await expect(
      flight.run('k', () => {
        throw new Error('sync')
      }),
    ).rejects.toThrow('sync')
    expect(await flight.run('k', async () => 1)).toBe(1)
  })
})
