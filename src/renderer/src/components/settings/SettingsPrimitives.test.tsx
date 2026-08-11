import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { SettingsCard, SettingsStatusPill } from './SettingsPrimitives'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('SettingsPrimitives', () => {
  it('renders a semantic card without losing its accessible name', () => {
    act(() => {
      renderer = TestRenderer.create(
        <SettingsCard as="section" aria-labelledby="panel-title">
          <h3 id="panel-title">项目设置</h3>
        </SettingsCard>
      )
    })

    const section = renderer?.root.findByType('section')
    assert.ok(section)
    assert.equal(section.props['aria-labelledby'], 'panel-title')
    assert.match(section.props.className, /settings-card/)
  })

  it('exposes status as data rather than a behavior-bearing class name', () => {
    act(() => {
      renderer = TestRenderer.create(
        <SettingsStatusPill status="warning">需要处理</SettingsStatusPill>
      )
    })

    const pill = renderer?.root.findByType('span')
    assert.ok(pill)
    assert.equal(pill.props['data-status'], 'warning')
    assert.doesNotMatch(pill.props.className, /settings-status-pill--warning/)
  })
})
