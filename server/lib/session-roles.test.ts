// Unit tests for the role-claim helpers that gate the admin back office.

import { describe, test, expect } from 'bun:test'
import { extractRoles, isAdminProfile, type Auth0Profile } from './session'
import { AUTH0_ROLES_CLAIM } from '../../shared/auth0-claims'

describe('extractRoles', () => {
  test('reads an array claim', () => {
    expect(extractRoles({ [AUTH0_ROLES_CLAIM]: ['admin', 'editor'] })).toEqual(['admin', 'editor'])
  })
  test('wraps a lone string claim', () => {
    expect(extractRoles({ [AUTH0_ROLES_CLAIM]: 'admin' })).toEqual(['admin'])
  })
  test('drops non-string array entries', () => {
    expect(extractRoles({ [AUTH0_ROLES_CLAIM]: ['admin', 3, null] })).toEqual(['admin'])
  })
  test('absent claim yields no roles', () => {
    expect(extractRoles({})).toEqual([])
  })
})

describe('isAdminProfile', () => {
  const base: Auth0Profile = { email: 'a@b.com', roles: [] }
  test('true only when roles include admin', () => {
    expect(isAdminProfile({ ...base, roles: ['admin'] })).toBe(true)
    expect(isAdminProfile({ ...base, roles: ['editor'] })).toBe(false)
    expect(isAdminProfile(base)).toBe(false)
  })
  test('null profile is not admin', () => {
    expect(isAdminProfile(null)).toBe(false)
  })
})
