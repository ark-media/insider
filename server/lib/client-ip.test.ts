// The per-client rate-limit key. What matters is that one host cannot buy
// itself unlimited buckets: an IPv6 host is routinely handed a whole /64, so
// the key is the prefix, not the address.

import { describe, expect, test } from 'bun:test'
import type { IncomingMessage } from 'node:http'
import { getClientIp, rateLimitKeyForIp } from './http'

function req(headers: Record<string, string | string[]>, remote?: string): IncomingMessage {
  return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage
}

describe('rateLimitKeyForIp', () => {
  test('IPv4 is used as-is', () => {
    expect(rateLimitKeyForIp('203.0.113.9')).toBe('203.0.113.9')
  })

  test('IPv6 collapses to its /64 prefix', () => {
    expect(rateLimitKeyForIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::/64')
  })

  test('every address in one /64 shares a key, whatever the spelling', () => {
    const a = rateLimitKeyForIp('2001:DB8:0000:0001::1')
    const b = rateLimitKeyForIp('2001:db8:0:1:ffff:ffff:ffff:ffff')
    const c = rateLimitKeyForIp('2001:db8:0:1::dead:beef')
    expect(a).toBe('2001:db8:0:1::/64')
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  test('neighbouring /64s do not share a key', () => {
    expect(rateLimitKeyForIp('2001:db8:0:1::1')).not.toBe(rateLimitKeyForIp('2001:db8:0:2::1'))
  })

  test('a leading "::" is expanded before the prefix is read', () => {
    expect(rateLimitKeyForIp('::1')).toBe('0:0:0:0::/64')
  })

  test('an IPv4-mapped address is keyed on the IPv4', () => {
    expect(rateLimitKeyForIp('::ffff:203.0.113.9')).toBe('203.0.113.9')
  })

  test('a zone id is dropped', () => {
    expect(rateLimitKeyForIp('fe80::1%en0')).toBe('fe80:0:0:0::/64')
  })
})

describe('getClientIp', () => {
  test('takes the leftmost x-forwarded-for entry', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }))).toBe('198.51.100.7')
  })

  test('normalises an IPv6 client to its /64', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '2001:db8:1:2:3:4:5:6' }))).toBe('2001:db8:1:2::/64')
  })

  test('falls back to the socket address', () => {
    expect(getClientIp(req({}, '127.0.0.1'))).toBe('127.0.0.1')
    expect(getClientIp(req({}))).toBe('unknown')
  })
})
