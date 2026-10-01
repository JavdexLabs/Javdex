import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import SettingsWorkspaceShell, { SettingsPluginDevShell } from './SettingsWorkspaceShell'
import { SETTINGS_GROUPS } from '../../settings/settingsRoutes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => { renderer?.unmount(); renderer = null })

test('settings shell owns its surface without changing group navigation or panel semantics', () => {
  const navigations: unknown[][] = []
  act(() => {
    renderer = TestRenderer.create(<MemoryRouter><SettingsWorkspaceShell activeGroup={SETTINGS_GROUPS[0]}
      activeTab="status" onNavigate={(...args) => navigations.push(args)} onTabKeyDown={() => {}}>
      <p>设置正文</p>
    </SettingsWorkspaceShell></MemoryRouter>)
  })
  const host = renderer!.root.find(node => node.type === 'div' && node.props['data-page-content'] !== undefined)
  assert.doesNotMatch(host.props.className, /scroll-body-inner--settings/)
  assert.equal(renderer!.root.findByProps({ id: 'settings-main-panel' }).props.role, 'region')
  assert.equal(renderer!.root.findByProps({ id: 'settings-main-panel' }).props['aria-label'], '概览设置')
  const link = renderer!.root.findAllByType('a').find(node => node.children.includes('媒体库'))!
  act(() => link.props.onClick({ button: 0, preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }))
  assert.deepEqual(navigations, [['library']])
})

test('plugin settings shell retains fill viewport without a descendant styling marker', () => {
  act(() => { renderer = TestRenderer.create(<SettingsPluginDevShell><p>开发工作区</p></SettingsPluginDevShell>) })
  const host = renderer!.root.find(node => node.type === 'div' && node.props['data-page-content'] !== undefined)
  assert.equal(host.props['data-plugin-dev-settings'], undefined)
  assert.equal(host.props['data-page-content'], true)
  assert.doesNotMatch(host.props.className, /scroll-body-inner--settings/)
  assert.equal(host.findByType('p').children.join(''), '开发工作区')
})
