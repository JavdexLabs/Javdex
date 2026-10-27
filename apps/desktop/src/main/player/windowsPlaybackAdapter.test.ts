import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectWindowsPlaybackAdapter } from './windowsPlaybackAdapter'

test('Windows adapter selection uses only the unique active consumer, ignoring inactive duplicate descriptions', () => {
  assert.deepEqual(selectWindowsPlaybackAdapter({ gpuDevice: [
    { active: false, vendorId: 0x10de, deviceId: 0x2704 },
    { active: true, vendorId: 0x8086, deviceId: 0x4680 },
    { active: false, vendorId: 0x8086, deviceId: 0x4680 }
  ] }), { vendorId: 0x8086, deviceId: 0x4680 })
})
test('unknown, malformed, software or ambiguous consumer identities do not guess a GPU', () => {
  for (const value of [null, {}, { gpuDevice: {} }, { gpuDevice: [] },
    { gpuDevice: [{ active: true, vendorId: 0x1414, deviceId: 0x8c }] },
    { gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: '0x4680' }] },
    { gpuDevice: [{ active: true, vendorId: -1, deviceId: 4 }] },
    { gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 0x10000 }] },
    { gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 1 }, { active: true, vendorId: 0x10de, deviceId: 1 }] }
  ]) assert.equal(selectWindowsPlaybackAdapter(value), undefined)
})
test('known Chromium preferences survive selection so native DXGI can disambiguate duplicate PCI identities', () => {
  assert.deepEqual(selectWindowsPlaybackAdapter({ gpuDevice: [
    { active: true, vendorId: 0x10de, deviceId: 0x2704, gpuPreference: 3 },
    { active: false, vendorId: 0x10de, deviceId: 0x2704, gpuPreference: 0 }
  ] }), { vendorId: 0x10de, deviceId: 0x2704, gpuPreference: 3 })
})
