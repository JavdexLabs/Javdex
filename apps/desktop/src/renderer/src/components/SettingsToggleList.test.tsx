import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsToggleList from './SettingsToggleList'
import SettingsSwitchRow from './SettingsSwitchRow'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  renderer?.unmount()
  renderer = null
})

it('preserves native enclosure attributes, children, and an explicit compact layout', () => {
  const changes: boolean[] = []
  act(() => {
    renderer = TestRenderer.create(
      <SettingsToggleList compact className="scope-layout" id="scope-list" aria-label="保护范围">
        <SettingsSwitchRow title="封面" description="保护封面" checked={false}
          onChange={(checked) => changes.push(checked)} />
      </SettingsToggleList>
    )
  })
  const list = renderer!.root.findByType('div')
  assert.equal(list.props.id, 'scope-list')
  assert.equal(list.props['aria-label'], '保护范围')
  assert.match(list.props.className, /compact/)
  assert.match(list.props.className, /scope-layout/)
  assert.doesNotMatch(list.props.className, /settings-toggle-list/)
  assert.equal(list.props.compact, undefined)
  assert.doesNotMatch(renderer!.root.findByType('label').props.className, /settings-toggle-item/)
  act(() => renderer!.root.findByType('input').props.onChange({ target: { checked: true } }))
  assert.deepEqual(changes, [true])
})
