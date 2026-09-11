import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { TagOptionsPage, TagOptionsQuery } from '@shared/commonTypes'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const requests: Array<{ query: TagOptionsQuery } & ReturnType<typeof deferred<TagOptionsPage>>> = []
const writes: Array<{ videoId: number; tagId?: number; name?: string } & ReturnType<typeof deferred<boolean>>> = []
const changed: number[] = []
const fakeApi = {
  tags: {
    manualOptions(query: TagOptionsQuery) {
      const request = { query, ...deferred<TagOptionsPage>() }
      requests.push(request)
      return request.promise
    },
    listManual() { throw new Error('full manual catalog must not be requested') }
  },
  videos: {
    addExistingManualTag(videoId: number, tagId: number) {
      const write = { videoId, tagId, ...deferred<boolean>() }; writes.push(write); return write.promise
    },
    addManualTag(videoId: number, name: string) {
      const write = { videoId, name, ...deferred<boolean>() }; writes.push(write); return write.promise
    },
    removeManualTag() { return Promise.resolve(true) }
  }
}
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true,
  value: Object.assign(new EventTarget(), { api: fakeApi, setTimeout, clearTimeout }) })
Object.defineProperty(globalThis, 'document', { configurable: true,
  value: { body: { style: { overflow: '' } }, activeElement: null } })
let Panel: typeof import('./VideoTagPanel')['default']
let Modal: typeof import('./Modal')['default']
before(async () => { Panel = (await import('./VideoTagPanel')).default; Modal = (await import('./Modal')).default })
let viewport = continuousViewport()
let renderer: TestRenderer.ReactTestRenderer | undefined
async function show(videoId = 1) {
  const element = <Panel videoId={videoId} tags={[]} onFilterTag={() => {}} onChanged={() => changed.push(videoId)} />
  await act(async () => {
    if (renderer) renderer.update(element)
    else renderer = TestRenderer.create(element, { createNodeMock: viewport.createNodeMock })
  })
}
function button(label: string) {
  return renderer!.root.findAllByType('button').find(node => node.props['aria-label'] === label || node.props.children === label)!
}
async function click(label: string) {
  if (label === '下一页' || label === '上一页') {
    const scroll = renderer!.root.findAll(node => node.props.className === 'video-tag-add-modal-catalog-scroll')[0]
    assert.ok(scroll?.props.onScroll, label)
    await act(async () => scroll.props.onScroll({
      currentTarget: { scrollTop: label === '下一页' ? 9840 : 0, clientHeight: 160, scrollHeight: 10000 }
    }))
    return
  }
  const node = button(label)
  assert.ok(node, label)
  assert.equal(Boolean(node.props.disabled), false, label)
  await act(async () => { node.props.onClick() })
}
function candidates() {
  return renderer!.root.findAllByType('button').filter(node => node.props['aria-pressed'] !== undefined)
}
async function resolve(index: number, items: TagOptionsPage['items'], hasMore = false) {
  await act(async () => { requests[index].resolve({ items, hasMore }) })
}
async function type(value: string) {
  await act(async () => { renderer!.root.findByType('input').props.onChange({ target: { value } }) })
}
async function debounce() { await act(async () => { await new Promise(done => setTimeout(done, 270)) }) }
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined; viewport=continuousViewport(); requests.length = 0; writes.length = 0; changed.length = 0
})

it('loads only on open, renders at most one page, and selects an existing tag by ID', async () => {
  await show()
  assert.equal(requests.length, 0)
  await click('添加自定义标签')
  assert.deepEqual(requests[0].query, { search: '', offset: 0, limit: 100 })
  await resolve(0, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, label: `Tag ${i + 1}` })), true)
  assert.equal(candidates().length, 100)
  await click('下一页')
  assert.equal(requests[1].query.offset, 100)
  assert.equal(candidates().length, 100)
  await resolve(1, [{ id: 999, label: 'A truncated label…' }])
  assert.ok(candidates().some(node => node.props.children === 'A truncated label…'))
  await act(async () => { candidates().at(-1)!.props.onClick() })
  assert.equal(writes[0].tagId, 999)
  assert.equal(writes[0].name, undefined)
  await act(async () => writes[0].resolve(true))
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  assert.deepEqual(changed, [1])
  assert.equal(requests.length, 2, 'no unused full refresh after adding')
})

it('debounces search, resets the page, and discards earlier search responses', async () => {
  await show(); await click('添加自定义标签')
  await resolve(0, [{ id: 1, label: 'Initial' }], true)
  await click('下一页')
  await type('New')
  assert.ok(candidates().length <= 1)
  await resolve(1, [{ id: 2, label: 'Old page' }])
  await debounce()
  assert.deepEqual(requests[2].query, { search: 'New', offset: 0, limit: 100 })
  await type('Newer'); await debounce()
  await resolve(3, [{ id: 4, label: 'Current' }])
  await resolve(2, [{ id: 3, label: 'Stale' }])
  assert.deepEqual(candidates().map(node => node.props.children), ['Current'])
})

it('shows errors with retry and discards closed-modal results before reopening', async () => {
  await show(); await click('添加自定义标签')
  await act(async () => requests[0].reject(new Error('database unavailable')))
  assert.equal(candidates().length, 0)
  await click('重试')
  await act(async () => renderer!.root.findByType(Modal).props.onCancel())
  await resolve(1, [{ id: 1, label: 'Closed result' }])
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  await click('添加自定义标签')
  assert.equal(candidates().length, 0)
  await resolve(2, [])
  assert.equal(button('下一页'), undefined)
})

it('keeps catalog rows and retry when a later page fails', async () => {
  await show(); await click('添加自定义标签')
  await resolve(0, [{ id: 1, label: 'Initial' }], true)
  await click('下一页')
  await act(async () => requests[1].reject(new Error('later failed')))
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 1)
  await click('重试')
  for (let index = 2; index < requests.length; index++) {
    const offset = requests[index].query.offset ?? 0
    await resolve(index, [{ id: offset + 1, label: offset ? 'Recovered' : 'Initial' }], offset === 0)
  }
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
})

it('creates from the full draft and prevents an old write completion from closing another video modal', async () => {
  await show(); await click('添加自定义标签')
  await type(' Fresh name ')
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
  assert.equal(writes[0].name, 'Fresh name')
  await show(2)
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  await click('添加自定义标签')
  await act(async () => writes[0].resolve(true))
  assert.equal(renderer!.root.findAllByType(Modal).length, 1)
  assert.deepEqual(changed, [])
})

it('refreshes stale candidates after a failed selection without retrying the write', async () => {
  await show(); await click('添加自定义标签')
  await resolve(0, [{ id: 9, label: 'Removed elsewhere' }])
  await act(async () => { candidates()[0].props.onClick() })
  await act(async () => writes[0].reject(new Error('标签已不存在，请重新选择')))
  assert.equal(writes.length, 1)
  assert.equal(requests.length, 2)
  assert.ok(candidates().length <= 1)
  await resolve(1, [])
  assert.equal(renderer!.root.findAllByType(Modal).length, 1)
  assert.equal(writes.length, 1)
})

it('does not inherit an open picker or issue a hidden request when switching videos', async () => {
  await show(1); await click('添加自定义标签')
  await show(2)
  assert.equal(renderer!.root.findAllByType(Modal).length, 0)
  assert.equal(requests.length, 1)
  await click('添加自定义标签')
  assert.equal(requests.length, 2)
  await resolve(1, [{ id: 2, label: 'New context' }])
  await resolve(0, [{ id: 1, label: 'Old context' }])
  assert.deepEqual(candidates().map(node => node.props.children), ['New context'])
})
