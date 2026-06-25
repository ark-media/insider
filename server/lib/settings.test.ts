// Unit tests for the launch-mode settings accessors. The DB is faked with a
// tagged-template stub that returns a fixed rows array, so these cover the
// default/validation logic without a live Neon connection.

import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_LAUNCH_MODE,
  getLaunchMode,
  isLaunchMode,
  setLaunchMode,
} from './settings.js'
import type { Sql } from './db.js'

function fakeSql(rows: unknown[]): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql
}

describe('isLaunchMode', () => {
  test('accepts only "soft" and "hard"', () => {
    expect(isLaunchMode('soft')).toBe(true)
    expect(isLaunchMode('hard')).toBe(true)
    expect(isLaunchMode('nope')).toBe(false)
    expect(isLaunchMode(undefined)).toBe(false)
    expect(isLaunchMode(null)).toBe(false)
  })
})

describe('getLaunchMode', () => {
  test('returns the stored value', async () => {
    expect(await getLaunchMode(fakeSql([{ value: 'hard' }]))).toBe('hard')
  })

  test('defaults to soft when no row exists', async () => {
    expect(DEFAULT_LAUNCH_MODE).toBe('soft')
    expect(await getLaunchMode(fakeSql([]))).toBe('soft')
  })

  test('defaults to soft on an unexpected stored value', async () => {
    expect(await getLaunchMode(fakeSql([{ value: 'weird' }]))).toBe('soft')
  })
})

describe('setLaunchMode', () => {
  test('returns the mode it set', async () => {
    expect(await setLaunchMode(fakeSql([]), 'hard')).toBe('hard')
    expect(await setLaunchMode(fakeSql([]), 'soft')).toBe('soft')
  })
})
