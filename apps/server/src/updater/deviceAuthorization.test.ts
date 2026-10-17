import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readDeviceUpdateBearer } from './deviceAuthorization'

test('update ingress accepts preserved 0.8.0 secrets and current device credentials', () => {
  for (const secret of [Buffer.alloc(32, 255).toString('base64url'), Buffer.alloc(32, 1).toString('base64url'), 'a'.repeat(64)]) {
    assert.equal(readDeviceUpdateBearer(`Bearer ${secret}`), secret)
  }
})

test('update ingress does not accept malformed or unbounded authorization headers', () => {
  for (const header of [undefined, '', 'Basic abc', `bearer ${'a'.repeat(64)}`, `Bearer ${'a'.repeat(42)}`,
    `Bearer ${'a'.repeat(44)}`, `Bearer ${'a'.repeat(65)}`, `Bearer ${'a'.repeat(43)} `,
    `Bearer ${'a'.repeat(43)}\n`, `Bearer ${'é'.repeat(43)}`, `Bearer ${'a+'.repeat(21)}0`]) {
    assert.equal(readDeviceUpdateBearer(header), undefined)
  }
})
