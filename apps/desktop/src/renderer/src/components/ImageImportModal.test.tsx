import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { renderedText } from '../test/renderedText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: { assets: { fetchRemoteImagePreview: async () => ({ mimeType: 'image/png', dataBase64: '' }) } }
}) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body: { style: { overflow: '' } }, activeElement: null
} })

test('partial image import preserves only failed items and retries without duplicating committed images', async () => {
  const { default: ImageImportModal } = await import('./ImageImportModal')
  const calls: string[] = []
  let changed = 0, closed = 0
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ImageImportModal title="导入图片" itemLabel="图片"
    emptyText="空" urlHint="链接" onCancel={() => { closed++ }} onChanged={() => { changed++ }}
    onImportFilePath={async () => { throw new Error('unexpected file') }}
    onImportUrl={async url => { calls.push(url); if (calls.length === 2) throw new Error('第二张失败') }} />) })
  const button = (text: string) => renderer.root.findAllByType('button').find(node => renderedText(node) === text)!
  try {
    act(() => button('图片链接').props.onClick())
    for (const url of ['https://example.test/one.png', 'https://example.test/two.png']) {
      act(() => renderer.root.findByProps({ type: 'url' }).props.onChange({ target: { value: url } }))
      await act(async () => { button('加载图片').props.onClick(); await Promise.resolve() })
    }
    await act(async () => { button('导入图片').props.onClick(); await Promise.resolve() })
    assert.equal(changed, 1)
    assert.equal(closed, 0)
    assert.equal(renderer.root.findAllByType('img').length, 1)
    assert.equal(renderer.root.findByProps({ role: 'alert' }).findByType('p').children.join(''), '第二张失败')
    await act(async () => { button('导入图片').props.onClick(); await Promise.resolve() })
    assert.deepEqual(calls, ['https://example.test/one.png', 'https://example.test/two.png', 'https://example.test/two.png'])
    assert.equal(changed, 2)
    assert.equal(closed, 1)
  } finally { act(() => renderer.unmount()) }
})
