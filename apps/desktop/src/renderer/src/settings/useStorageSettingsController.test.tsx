import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useStorageSettingsController, type StoragePatch } from './useStorageSettingsController'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('storage confirmation keeps its intent after failure and locks duplicate commits', async () => {
  let result!: ReturnType<typeof useStorageSettingsController>
  const settings: StoragePatch = { assetEncryption: false, mediaAssetsPath: '', mediaAssetsResolvedPath: '/fixture' }
  let calls = 0
  let finish!: (value: StoragePatch) => void
  const pending = new Promise<StoragePatch>(resolve => { finish = resolve })
  const saved: unknown[] = []
  function Harness() {
    result = useStorageSettingsController({ settings, onSaved: patch => saved.push(patch), notify: () => {},
      storage: { pickFolder: async () => [], relocate: async () => settings, setEnabled: async () => { if (++calls === 1) throw Error('failed'); return pending } } })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness />); await Promise.resolve() })
  await act(async () => result.requestEncryption(true))
  await act(async () => result.confirm())
  assert.deepEqual(result.action, { kind: 'crypto', enabled: true })
  let running!: Promise<void>
  act(() => { running = result.confirm(); void result.confirm(); result.cancel() })
  assert.equal(calls, 2)
  assert.equal(result.busy, true)
  await act(async () => { finish({ ...settings, assetEncryption: true }); await running })
  assert.equal(saved.length, 1)
  assert.equal(result.action, null)
  act(() => renderer.unmount())
})

test('a late folder picker cannot replace a newer encryption confirmation', async () => {
  let result!: ReturnType<typeof useStorageSettingsController>
  const settings: StoragePatch = { assetEncryption: false, mediaAssetsPath: '', mediaAssetsResolvedPath: '/fixture' }
  let finish!: (paths: string[]) => void
  const folder = new Promise<string[]>(resolve => { finish = resolve })
  function Harness() {
    result = useStorageSettingsController({ settings, onSaved: () => {}, notify: () => {},
      storage: { pickFolder: () => folder, setEnabled: async () => settings, relocate: async () => settings } })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness />) })
  let picking!: Promise<void>
  act(() => { picking = result.requestRelocate() })
  await act(async () => result.requestEncryption(true))
  await act(async () => { finish(['/new']); await picking })
  assert.deepEqual(result.action, { kind: 'crypto', enabled: true })
  act(() => result.cancel())
  assert.equal(result.action, null)
  act(() => renderer.unmount())
})

test('unmounted settings ignore completed storage I/O and stale commands', async () => {
  let result!: ReturnType<typeof useStorageSettingsController>
  const settings: StoragePatch = { assetEncryption: false, mediaAssetsPath: '', mediaAssetsResolvedPath: '/fixture' }
  let finish!: (patch: StoragePatch) => void
  const saving = new Promise<StoragePatch>(resolve => { finish = resolve })
  const effects: string[] = []
  function Harness() {
    result = useStorageSettingsController({ settings, onSaved: () => effects.push('saved'), notify: () => effects.push('notice'),
      storage: { pickFolder: async () => { effects.push('picker'); return [] }, setEnabled: () => saving, relocate: async () => settings } })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<Harness />) })
  await act(async () => result.requestEncryption(true))
  let running!: Promise<void>
  act(() => { running = result.confirm() })
  act(() => renderer.unmount())
  await act(async () => { finish({ ...settings, assetEncryption: true }); await running; await result.requestRelocate() })
  assert.deepEqual(effects, [])
})
