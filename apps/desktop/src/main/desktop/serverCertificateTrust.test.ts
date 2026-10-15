import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { createServerCertificateTrust } from './serverCertificateTrust'

const cipher = { assertAvailable() {}, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
const oldPin = 'a'.repeat(64), newPin = 'b'.repeat(64)

it('automatically saves the first self-signed certificate and only confirms a later change', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-certificate-'))
  try {
    let prompts = 0, accept = false
    const trust = createServerCertificateTrust(root, 'https://example.test', async (origin, previous, current) => {
      prompts++; assert.equal(origin, 'https://example.test'); assert.equal(previous, oldPin); assert.equal(current, newPin); return accept
    }, cipher)
    await trust(oldPin, false)
    await trust(oldPin, false)
    assert.equal(prompts, 0)
    await assert.rejects(trust(newPin, false), /已取消连接/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server-certificates.bin'), 'utf8'))['https://example.test'], oldPin)
    accept = true
    await trust(newPin, false)
    await createServerCertificateTrust(root, 'https://example.test', async () => { assert.fail('a saved decision survives restart') }, cipher)(newPin, false)
    assert.equal(prompts, 2)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('accepts valid public certificate rotations without confirmation and preserves other origins', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-public-certificate-'))
  try {
    const confirm = async () => { assert.fail('a valid public certificate does not require confirmation') }
    const trust = createServerCertificateTrust(root, 'https://example.test', confirm, cipher)
    await trust(oldPin, false)
    await trust(newPin, true)
    await createServerCertificateTrust(root, 'https://other.test', confirm, cipher)(oldPin, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'server-certificates.bin'), 'utf8')), { 'https://example.test': newPin, 'https://other.test': oldPin })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('shares a single confirmation and refusal across concurrent requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-certificate-concurrent-'))
  try {
    let prompts = 0
    const trust = createServerCertificateTrust(root, 'https://example.test', async () => { prompts++; return false }, cipher)
    await trust(oldPin, false)
    const outcomes = await Promise.allSettled([trust(newPin, false), trust(newPin, false), trust(newPin, false)])
    assert.ok(outcomes.every(value => value.status === 'rejected'))
    assert.equal(prompts, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
