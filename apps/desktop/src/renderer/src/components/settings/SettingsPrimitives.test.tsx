import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { SettingsCard, SettingsStatusPill, SettingsNumberStepper } from './SettingsPrimitives'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('SettingsPrimitives', () => {
  it('retains an invalid value with an accessible error instead of silently clamping it', () => {
    act(() => {
      renderer = TestRenderer.create(
        <SettingsNumberStepper
          value={30}
          min={0}
          max={60}
          onChange={() => assert.fail('invalid input must not be saved')}
        />
      )
    })
    const input = renderer!.root.findByType('input')
    act(() => input.props.onFocus())
    act(() => input.props.onChange({ target: { value: '999' } }))
    act(() => input.props.onBlur())
    assert.equal(input.props.value, '999')
    assert.equal(input.props['aria-invalid'], true)
    assert.equal(
      renderer!.root.findByProps({ role: 'alert' }).props.id,
      input.props['aria-describedby']
    )
  })
  it('keeps a multi-digit number local until the edit is committed', () => {
    const values: number[] = []
    act(() => {
      renderer = TestRenderer.create(
        <SettingsNumberStepper
          value={30}
          min={0}
          max={600}
          onChange={(value) => values.push(value)}
        />
      )
    })
    const input = renderer!.root.findByType('input')
    act(() => input.props.onFocus())
    act(() => input.props.onChange({ target: { value: '1' } }))
    act(() => input.props.onChange({ target: { value: '120' } }))
    assert.deepEqual(values, [])
    act(() => input.props.onBlur())
    assert.deepEqual(values, [120])
  })

  it('supports keyboard activation of increment and does not treat empty input as zero', () => {
    const values: number[] = []
    act(() => {
      renderer = TestRenderer.create(
        <SettingsNumberStepper value={30} onChange={(value) => values.push(value)} />
      )
    })
    const plus = renderer!.root.findByProps({ 'aria-label': '增加' })
    act(() => plus.props.onClick?.({ detail: 0 }))
    assert.deepEqual(values, [31])
    const input = renderer!.root.findByType('input')
    act(() => input.props.onFocus())
    act(() => input.props.onChange({ target: { value: '' } }))
    act(() => input.props.onBlur())
    assert.deepEqual(values, [31])
  })
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
