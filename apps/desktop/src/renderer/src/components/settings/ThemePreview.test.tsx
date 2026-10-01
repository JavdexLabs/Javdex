import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { ThemeChoice, ThemeSwatch } from './ThemePreview'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  renderer?.unmount()
  renderer = null
})

it('keeps each palette choice semantic and forwards its keyboard and selection events', () => {
  let clicks = 0
  const keys: string[] = []
  act(() => {
    renderer = TestRenderer.create(
      <ThemeChoice
        option={{ id: 'warm', label: '暖灰', hint: '柔和暖灰，低饱和' }}
        selected
        onClick={() => clicks++}
        onKeyDown={(event) => keys.push(event.key)}
      />
    )
  })
  const radio = renderer!.root.findByType('button')
  assert.equal(radio.props.role, 'radio')
  assert.equal(radio.props['aria-checked'], true)
  assert.equal(radio.props.tabIndex, 0)
  assert.equal(radio.props['data-theme'], 'warm')
  assert.doesNotMatch(radio.props.className, /theme-option|active/)
  act(() => radio.props.onClick())
  act(() => radio.props.onKeyDown({ key: 'ArrowRight' }))
  assert.equal(clicks, 1)
  assert.deepEqual(keys, ['ArrowRight'])
  act(() => {
    renderer!.update(
      <ThemeChoice option={{ id: 'warm', label: '暖灰', hint: '预览' }} selected={false}
        onClick={() => {}} onKeyDown={() => {}} />
    )
  })
  assert.equal(radio.props['aria-checked'], false)
  assert.equal(radio.props.tabIndex, -1)
})

it('keeps the shared swatch decorative and exposes only an explicit layout class', () => {
  act(() => {
    renderer = TestRenderer.create(<ThemeSwatch theme="light" className="overview-layout" />)
  })
  const swatch = renderer!.root.findByType('span')
  assert.equal(swatch.props['data-theme'], 'light')
  assert.equal(swatch.props['aria-hidden'], true)
  assert.match(swatch.props.className, /overview-layout/)
  assert.doesNotMatch(swatch.props.className, /theme-swatch/)
})
