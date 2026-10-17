import assert from 'node:assert/strict'
import { test } from 'node:test'
import { updaterPairingSchema, serverUpdateCommandSchema } from './serverUpdateTypes'

const pairing = {
  protocolVersion: 1, url: 'https://nas.example:8096', certificateSha256: 'a'.repeat(64),
  serverId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222'
}
// Same encoding and entropy length as published 0.8.0's randomBytes(32).
const legacySecret = Buffer.alloc(32, 255).toString('base64url')

test('saved unified connection accepts the published 0.8.0 writer secret without reissuing it', () => {
  assert.equal(legacySecret.length, 43)
  assert.equal(updaterPairingSchema.parse({ ...pairing, token: legacySecret }).token, legacySecret)
  assert.equal(updaterPairingSchema.parse({ ...pairing, token: 'b'.repeat(64) }).token, 'b'.repeat(64))
})

test('writer credentials remain bounded and are not one-time enrollment codes', () => {
  for (const token of ['', 'b'.repeat(42), 'b'.repeat(44), 'b'.repeat(63), 'b'.repeat(65), `${legacySecret} `, 'é'.repeat(43), 'a+'.repeat(21) + '0']) {
    assert.equal(updaterPairingSchema.safeParse({ ...pairing, token }).success, false)
  }
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'connect', remoteBaseUrl: pairing.url, oneTimeToken: legacySecret }).success, false)
  assert.equal(serverUpdateCommandSchema.safeParse({ action: 'connect', remoteBaseUrl: pairing.url, oneTimeToken: 'c'.repeat(64) }).success, true)
})
