import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { verifySvixSignature } from './svix'

const RAW = Buffer.from('MIIBMjCB2QIBATAFMAMCAQEwDAYIKoZIhvcNAgUFAA==', 'base64')
const SECRET = `whsec_${RAW.toString('base64')}`
const BODY = Buffer.from('{"event_type":"subscription.upgraded","uid":"evt_1"}')
const NOW = 1_760_000_000

function sign(id: string, ts: number, body: Buffer, secret: Buffer = RAW): string {
  return createHmac('sha256', secret).update(`${id}.${ts}.`).update(body).digest('base64')
}

function headers(sig: string, ts: number = NOW, id = 'msg_1') {
  return { id, timestamp: String(ts), signature: sig }
}

describe('verifySvixSignature', () => {
  test('accepts a correctly signed, fresh delivery', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY)}`
    expect(verifySvixSignature(headers(sig), BODY, SECRET, { nowSec: NOW })).toBe(true)
  })

  test('accepts when any one of several v1 entries matches (secret rotation)', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY, Buffer.from('other'))} v1,${sign('msg_1', NOW, BODY)}`
    expect(verifySvixSignature(headers(sig), BODY, SECRET, { nowSec: NOW })).toBe(true)
  })

  test('rejects a tampered body', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY)}`
    const other = Buffer.from('{"event_type":"subscription.deleted","uid":"evt_1"}')
    expect(verifySvixSignature(headers(sig), other, SECRET, { nowSec: NOW })).toBe(false)
  })

  test('rejects a signature made with another secret', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY, Buffer.from('nope'))}`
    expect(verifySvixSignature(headers(sig), BODY, SECRET, { nowSec: NOW })).toBe(false)
  })

  test('rejects a replay outside the tolerance window', () => {
    const old = NOW - 6 * 60
    const sig = `v1,${sign('msg_1', old, BODY)}`
    expect(verifySvixSignature(headers(sig, old), BODY, SECRET, { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature(headers(sig, old), BODY, SECRET, { nowSec: NOW, toleranceSec: 600 })).toBe(true)
  })

  test('rejects a delivery whose id or timestamp was changed after signing', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY)}`
    expect(verifySvixSignature(headers(sig, NOW, 'msg_2'), BODY, SECRET, { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature(headers(sig, NOW + 1), BODY, SECRET, { nowSec: NOW })).toBe(false)
  })

  test('rejects missing headers, unknown versions and an empty secret', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY)}`
    expect(verifySvixSignature({ ...headers(sig), signature: undefined }, BODY, SECRET, { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature({ ...headers(sig), id: undefined }, BODY, SECRET, { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature(headers(`v0,${sign('msg_1', NOW, BODY)}`), BODY, SECRET, { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature(headers(sig), BODY, '', { nowSec: NOW })).toBe(false)
    expect(verifySvixSignature(headers(sig), BODY, 'whsec_', { nowSec: NOW })).toBe(false)
  })

  test('works with the secret given without its whsec_ prefix', () => {
    const sig = `v1,${sign('msg_1', NOW, BODY)}`
    expect(verifySvixSignature(headers(sig), BODY, RAW.toString('base64'), { nowSec: NOW })).toBe(true)
  })
})
