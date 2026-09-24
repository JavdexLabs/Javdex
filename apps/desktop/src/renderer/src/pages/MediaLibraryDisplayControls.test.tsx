import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createMediaLibraryDraft } from '../mediaLibrarySettingsState'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {} } })

it('uses the shared switch for home discovery and keeps changes in the settings draft', async () => {
  const { DisplaySettingsTab } = await import('./MediaLibrarySettingsTabs')
  const config = createMediaLibraryDraft().config
  const changes: unknown[] = []
  let saves = 0
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<DisplaySettingsTab configDraft={config} formDisabled={false}
      updateConfigDraft={(key, value) => { changes.push([key, value]) }}
      saveConfig={async () => { saves += 1 }} />)
  })
  try {
    const control = renderer.root.findByProps({ role: 'switch' })
    assert.equal(control.type, 'input')
    await act(async () => control.props.onChange({ target: { checked: false } }))
    assert.deepEqual(changes, [['includeInHomeDiscovery', false]])
    assert.equal(saves, 0)
  } finally {
    renderer.unmount()
  }
})
