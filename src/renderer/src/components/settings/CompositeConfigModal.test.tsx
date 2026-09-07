import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { CompositeScraperInput, ScraperPluginDescriptor } from '@shared/scrapeTypes'
import CompositeConfigModal from './CompositeConfigModal'
import SelectControl from '../SelectControl'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener() {}, removeEventListener() {} }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: null, body: { style: {} } }
})
let renderer: TestRenderer.ReactTestRenderer
afterEach(() => {
  act(() => renderer?.unmount())
})

function source(
  name: string,
  supportedFields: ScraperPluginDescriptor['supportedFields'],
  extra: Partial<ScraperPluginDescriptor> = {}
): ScraperPluginDescriptor {
  return {
    kind: 'actress',
    name,
    supportedFields,
    version: '1.0',
    description: '',
    source: 'builtin',
    removable: false,
    exportable: false,
    editable: false,
    debuggable: false,
    delay: { minMs: 0, maxMs: 0 },
    ...extra
  }
}
const sources = [
  source('资料源', ['birthDate', 'profileSummary']),
  source('图片源', ['avatar', 'gallery'])
]
function button(label: string) {
  return renderer.root.findAllByType('button').find((item) => item.children.includes(label))!
}
function select(label: string) {
  return renderer.root
    .findAllByType(SelectControl)
    .find((item) => item.props['aria-label'] === label)!
}

it('applies supported fields, preserves other mappings, allows overrides and only persists on save', () => {
  const saved: CompositeScraperInput[] = []
  act(() => {
    renderer = TestRenderer.create(
      <CompositeConfigModal
        state={{ kind: 'actress' }}
        plugins={sources}
        onCancel={() => {}}
        onSave={(_kind, _original, input) => saved.push(input)}
      />
    )
  })
  assert.equal(button('创建组合').props.disabled, true)
  act(() =>
    renderer.root.findAllByType('input')[0].props.onChange({ target: { value: ' 我的组合 ' } })
  )
  act(() => select('头像来源').props.onChange({ target: { value: '图片源' } }))
  act(() => select('起始插件').props.onChange({ target: { value: '资料源' } }))
  act(() => button('应用到支持字段').props.onClick())
  assert.equal(select('生日来源').props.value, '资料源')
  assert.equal(select('简介来源').props.value, '资料源')
  assert.equal(select('头像来源').props.value, '图片源')
  assert.equal(select('写真来源').props.value, '')
  assert.equal(saved.length, 0)
  act(() => button('撤销应用').props.onClick())
  assert.equal(select('生日来源').props.value, '')
  assert.equal(select('头像来源').props.value, '图片源')
  act(() => button('应用到支持字段').props.onClick())
  act(() => select('简介来源').props.onChange({ target: { value: '' } }))
  act(() => button('创建组合').props.onClick())
  assert.deepEqual(saved[0], {
    name: '我的组合',
    description: '',
    fieldPluginMap: { avatar: '图片源', birthDate: '资料源' }
  })
})

it('rejects unavailable saved sources and keeps missing references visible for repair', () => {
  act(() => {
    renderer = TestRenderer.create(
      <CompositeConfigModal
        state={{
          kind: 'actress',
          plugin: source('旧组合', ['avatar'], {
            source: 'composite',
            fieldPluginMap: { avatar: '已卸载来源' }
          })
        }}
        plugins={sources}
        onCancel={() => {}}
        onSave={() => assert.fail('invalid mapping must not save')}
      />
    )
  })
  assert.equal(select('头像来源').props.value, '已卸载来源')
  assert.equal(select('头像来源').props['aria-invalid'], true)
  assert.equal(button('保存更改').props.disabled, true)
  assert.ok(renderer.root.findByProps({ role: 'alert' }))
})

it('excludes nested and other-kind plugins and prevents applying unconfigured sources', () => {
  act(() => {
    renderer = TestRenderer.create(
      <CompositeConfigModal
        state={{ kind: 'actress' }}
        plugins={[
          source('未配置', ['avatar'], { configured: false }),
          source('另一个组合', ['avatar'], { source: 'composite' }),
          source('影片源', ['title'], { kind: 'video' })
        ]}
        onCancel={() => {}}
        onSave={() => assert.fail('no runnable source')}
      />
    )
  })
  assert.equal(button('应用到支持字段').props.disabled, true)
  assert.equal(select('起始插件').props.disabled, true)
  const options = React.Children.toArray(select('起始插件').props.children) as React.ReactElement[]
  assert.ok(options.some((item) => item.props.value === '未配置' && item.props.disabled))
  assert.equal(
    options.some((item) => item.props.value === '另一个组合' || item.props.value === '影片源'),
    false
  )
})

it('uses video field capabilities for bulk assignment', () => {
  act(() => {
    renderer = TestRenderer.create(
      <CompositeConfigModal
        state={{ kind: 'video' }}
        plugins={[source('影片源', ['title', 'cover'], { kind: 'video' })]}
        onCancel={() => {}}
        onSave={() => {}}
      />
    )
  })
  act(() => button('应用到支持字段').props.onClick())
  assert.equal(select('标题来源').props.value, '影片源')
  assert.equal(select('封面来源').props.value, '影片源')
})
