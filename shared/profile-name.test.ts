// Unit tests for the shared name helpers.
//
// The property that matters most: a name we manufactured from an email address
// must never be mistaken for one a member gave us. Every greeting, the account
// prompt, and the backfill filter all key on `hasRealName`, so a false positive
// here ships "Hi hannah.waxman8," to the whole list.

import { describe, test, expect } from 'bun:test'
import {
  MAX_NAME_PART_LEN,
  displayName,
  greetingFirstName,
  hasRealName,
  looksLikeEmailLocalPart,
  splitFullName,
} from './profile-name'

describe('splitFullName', () => {
  test('splits on the first space, keeping compound surnames intact', () => {
    expect(splitFullName('Ada Lovelace')).toEqual({
      first: 'Ada',
      last: 'Lovelace',
    })
    expect(splitFullName('Ada Lovelace King')).toEqual({
      first: 'Ada',
      last: 'Lovelace King',
    })
  })

  test('a mononym is a first name with no surname', () => {
    expect(splitFullName('Prince')).toEqual({ first: 'Prince' })
  })

  test('collapses stray whitespace rather than minting empty parts', () => {
    expect(splitFullName('  Ada   Lovelace  ')).toEqual({
      first: 'Ada',
      last: 'Lovelace',
    })
  })

  test('returns nothing for empty, null, and undefined', () => {
    expect(splitFullName('')).toEqual({})
    expect(splitFullName('   ')).toEqual({})
    expect(splitFullName(null)).toEqual({})
    expect(splitFullName(undefined)).toEqual({})
  })

  test('caps each part so Auth0 never rejects the write', () => {
    const long = 'a'.repeat(80)
    const parts = splitFullName(`${long} ${long}`)
    expect(parts.first).toHaveLength(MAX_NAME_PART_LEN)
    expect(parts.last).toHaveLength(MAX_NAME_PART_LEN)
  })
})

describe('looksLikeEmailLocalPart', () => {
  test('recognises the value both create paths manufacture', () => {
    expect(
      looksLikeEmailLocalPart('hannah.waxman8', 'hannah.waxman8@gmail.com'),
    ).toBe(true)
  })

  test('ignores punctuation and case when comparing', () => {
    expect(
      looksLikeEmailLocalPart('hannahwaxman8', 'hannah.waxman8@gmail.com'),
    ).toBe(true)
    expect(
      looksLikeEmailLocalPart('Hannah.Waxman8', 'hannah.waxman8@gmail.com'),
    ).toBe(true)
  })

  test('treats a whole address in a name field as junk', () => {
    expect(looksLikeEmailLocalPart('someone@else.com', 'me@example.com')).toBe(
      true,
    )
  })

  test('a genuine name that differs from the local part is not junk', () => {
    expect(looksLikeEmailLocalPart('Hannah', 'hwaxman@example.com')).toBe(false)
  })

  test('is false when either side is missing', () => {
    expect(looksLikeEmailLocalPart('', 'me@example.com')).toBe(false)
    expect(looksLikeEmailLocalPart('Hannah', '')).toBe(false)
    expect(looksLikeEmailLocalPart(null, null)).toBe(false)
  })
})

describe('hasRealName', () => {
  const email = 'hannah.waxman8@gmail.com'

  test('rejects the manufactured local part', () => {
    expect(hasRealName({ givenName: 'hannah.waxman8', email })).toBe(false)
  })

  test('rejects a blank or whitespace given name', () => {
    expect(hasRealName({ givenName: '', email })).toBe(false)
    expect(hasRealName({ givenName: '   ', email })).toBe(false)
    expect(hasRealName({ givenName: null, email })).toBe(false)
  })

  test('accepts an ordinary first name', () => {
    expect(hasRealName({ givenName: 'Hannah', email })).toBe(true)
  })

  test('a surname is proof on its own — we never manufactured one', () => {
    expect(
      hasRealName({ givenName: 'hannah.waxman8', familyName: 'Waxman', email }),
    ).toBe(true)
    // Legitimately lowercase names are safe as soon as a surname is present.
    expect(hasRealName({ givenName: 'bell', familyName: 'hooks', email })).toBe(
      true,
    )
  })

  test('a capitalized name matching the local part reads as typed, not auto-filled', () => {
    expect(hasRealName({ givenName: 'Hannah', email: 'hannah@example.com' })).toBe(
      true,
    )
  })

  test('a lowercase name matching the local part is treated as auto-filled', () => {
    // Deliberate: this is exactly the shape the create path writes, and the cost
    // of being wrong is one prompt rather than a mail-merge accident.
    expect(hasRealName({ givenName: 'hannah', email: 'hannah@example.com' })).toBe(
      false,
    )
  })

  test('survives a missing email', () => {
    expect(hasRealName({ givenName: 'Hannah' })).toBe(true)
    expect(hasRealName({ givenName: 'hannah.waxman8' })).toBe(true)
  })
})

describe('greetingFirstName', () => {
  test('greets by a real first name', () => {
    expect(greetingFirstName('Hannah', 'hwaxman@example.com')).toBe('Hannah')
  })

  test('returns undefined for a manufactured name so callers fall back', () => {
    expect(
      greetingFirstName('hannah.waxman8', 'hannah.waxman8@gmail.com'),
    ).toBeUndefined()
  })

  test('a surname rescues an otherwise junk-looking first name', () => {
    expect(
      greetingFirstName('hannah.waxman8', 'hannah.waxman8@gmail.com', 'Waxman'),
    ).toBe('hannah.waxman8')
  })
})

describe('displayName', () => {
  test('joins first and last', () => {
    expect(
      displayName({ givenName: 'Hannah', familyName: 'Waxman', email: 'h@x.com' }),
    ).toBe('Hannah Waxman')
  })

  test('a real mononym stands alone', () => {
    expect(displayName({ givenName: 'Prince', email: 'p@x.com' })).toBe('Prince')
  })

  test('returns undefined when the only name we hold is manufactured', () => {
    expect(
      displayName({ givenName: 'hannah.waxman8', email: 'hannah.waxman8@x.com' }),
    ).toBeUndefined()
  })
})
