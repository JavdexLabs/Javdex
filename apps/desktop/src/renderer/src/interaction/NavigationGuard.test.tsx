import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { useState, type ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createHashRouter, createMemoryRouter, RouterProvider, Routes, Route, useNavigate } from 'react-router-dom'
import { NavigationGuardProvider, useNavigationGuard, type NavigationDecision } from './NavigationGuard'
import { OverlayHistoryProvider, useOverlayHistory } from './OverlayHistoryContext'
import SettingsLeaveGuard, { useSettingsFormGuard } from '../settings/SettingsLeaveGuard'
import { PluginDevLeaveGuardProvider, usePluginDevLeaveGuard } from '../components/pluginDev/PluginDevLeaveGuard'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

async function hashFixture(children?: ReactNode) {
  const oldWindow = globalThis.window, oldDocument = globalThis.document
  type Entry = { state: { idx: number; key: string; usr: unknown }; url: string }
  const stack: Entry[] = [
    { state: { idx: 0, key: 'library', usr: { scope: 'library' } }, url: 'http://fixture/#/library' },
    { state: { idx: 1, key: 'detail', usr: { from: 'library' } }, url: 'http://fixture/#/detail' }
  ]
  let index = 1
  const listeners = new Map<string, Set<EventListener>>()
  const queued: number[] = [], goes: number[] = []
  const timers = new Map<number, () => void>()
  let timer = 0
  const location = { href: '', origin: '', pathname: '', search: '', hash: '' }
  const sync = () => {
    const url = new URL(stack[index].url)
    for (const field of ['href', 'origin', 'pathname', 'search', 'hash'] as const) location[field] = url[field]
  }
  sync()
  const host = {
    location,
    document: { body: { style: {} }, activeElement: null, querySelector: () => null, createElement: () => ({}) },
    addEventListener(type: string, listener: EventListener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener(type: string, listener: EventListener) { listeners.get(type)?.delete(listener) },
    setTimeout(callback: () => void) { timers.set(++timer, callback); return timer },
    clearTimeout(id: number) { timers.delete(id) },
    history: {
      get state() { return stack[index].state },
      pushState(state: Entry['state'], _title: string, url: string) {
        stack.splice(++index); stack.push({ state, url: new URL(url, location.href).href }); sync()
      },
      replaceState(state: Entry['state'], _title: string, url?: string) {
        stack[index] = { state, url: url ? new URL(url, location.href).href : location.href }; sync()
      },
      go(delta: number) { queued.push(delta); goes.push(delta) }
    }
  }
  Object.assign(host.document, { defaultView: host })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: host })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: host.document })
  let overlay!: ReturnType<typeof useOverlayHistory>
  function Capture() { overlay = useOverlayHistory(); return null }
  const router = createHashRouter([{ path: '*', element:
    <OverlayHistoryProvider><NavigationGuardProvider><PluginDevLeaveGuardProvider><SettingsLeaveGuard>
      <Capture />{children}
    </SettingsLeaveGuard></PluginDevLeaveGuardProvider></NavigationGuardProvider></OverlayHistoryProvider>
  }], { window: host as unknown as Window })
  let tree!: TestRenderer.ReactTestRenderer
  await act(async () => { tree = TestRenderer.create(<RouterProvider router={router} />) })
  const move = (delta: number) => {
    index += delta
    assert.ok(stack[index], `history cursor ${index}`)
    sync()
    return structuredClone(stack[index].state)
  }
  const deliver = (state = stack[index].state) => {
    // The hash router registers first, before the provider's passive effect.
    for (const listener of [...listeners.get('popstate') ?? []]) listener({ state } as PopStateEvent)
  }
  const pop = () => {
    assert.ok(queued.length, 'an asynchronous history traversal is pending')
    deliver(move(queued.shift()!))
  }
  return {
    router, overlay, tree, stack, queued, goes, move, deliver, pop,
    cursor: () => index,
    state: () => stack[index].state,
    fallback: () => { for (const callback of [...timers.values()]) callback() },
    dispose: () => {
      act(() => tree.unmount()); router.dispose()
      Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
      Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument })
    }
  }
}

test('a business PUSH survives the same-route overlay POP resetting the hash router blocker', async () => {
  const f = await hashFixture()
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    await act(async () => { await f.router.navigate('/next?scope=library#section', { state: { from: 'detail' } }) })
    assert.equal(f.router.state.location.pathname, '/detail')
    await act(async () => { f.pop() })
    assert.equal(f.router.state.location.pathname, '/next')
    assert.equal(f.router.state.location.search, '?scope=library')
    assert.equal(f.router.state.location.hash, '#section')
    assert.deepEqual(f.router.state.location.state, { from: 'detail' })
    assert.equal(f.router.state.historyAction, 'PUSH')
    assert.equal(f.cursor(), 2)
    assert.equal(f.stack.length, 3, 'one business entry replaces the consumed overlay forward branch')
    assert.deepEqual(f.goes, [-1])
  } finally { f.dispose() }
})

test('a deferred REPLACE preserves replacement rather than adding a business history entry', async () => {
  const f = await hashFixture()
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    await act(async () => { await f.router.navigate('/next', { replace: true, state: { replaced: 'detail' } }) })
    await act(async () => { f.pop() })
    assert.equal(f.router.state.location.pathname, '/next')
    assert.equal(f.router.state.historyAction, 'REPLACE')
    assert.deepEqual(f.router.state.location.state, { replaced: 'detail' })
    assert.equal(f.cursor(), 1)
    assert.equal(f.state().idx, 1)
    assert.equal(f.stack.length, 3, 'replace retains the forward branch instead of pushing a fourth entry')
    assert.deepEqual(f.goes, [-1])
  } finally { f.dispose() }
})

test('a deferred business POP keeps its destination cursor and forward branch after the blocker resets', async () => {
  const decisions: NavigationDecision[] = []
  function Draft() { useNavigationGuard(() => true, decision => decisions.push(decision)); return null }
  const f = await hashFixture(<Draft />)
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    // The owned back moved to detail, but its event is delayed past the business back.
    const delayed = f.move(f.queued.shift()!)
    const navigation = f.router.navigate(-1)
    await act(async () => { f.pop(); await navigation })
    assert.equal(f.router.state.location.pathname, '/detail')
    assert.equal(decisions.length, 1)
    await act(async () => { f.pop() }) // Router's automatic rollback to detail.
    await act(async () => { f.deliver(delayed) }) // Same-route raw POP resets the blocker.
    assert.equal([...f.router.state.blockers.values()][0].state, 'unblocked')
    await act(async () => { decisions[0].proceed() })
    assert.deepEqual(f.queued, [-1], 'approval reissues a traversal, never a PUSH')
    await act(async () => { f.pop() })
    assert.equal(f.router.state.location.pathname, '/library')
    assert.equal(f.router.state.historyAction, 'POP')
    assert.equal(f.router.state.location.key, 'library')
    assert.deepEqual(f.router.state.location.state, { scope: 'library' })
    assert.equal(f.cursor(), 0)
    assert.equal(f.stack.length, 3)
    assert.equal(decisions.length, 1, 'an approved draft cannot prompt again during replay')
    const forward = f.router.navigate(1)
    await act(async () => { f.pop(); await forward })
    assert.equal(decisions.length, 2, 'approval is not a permanent bypass for later navigation')
    await act(async () => { f.pop(); decisions[1].proceed() })
    await act(async () => { f.pop() })
    assert.equal(f.cursor(), 1)
    assert.equal(f.router.state.location.key, 'detail')
  } finally { f.dispose() }
})

test('POP approval survives a late owned event between router rollback and original proceed traversal', async () => {
  const decisions: NavigationDecision[] = []
  function Draft() { useNavigationGuard(() => true, decision => decisions.push(decision)); return null }
  const f = await hashFixture(<Draft />)
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    const delayed = f.move(f.queued.shift()!)
    const navigation = f.router.navigate(-1)
    await act(async () => { f.pop(); await navigation })
    await act(async () => { decisions[0].proceed() })
    await act(async () => { f.pop() }) // Original proceed waits for this router rollback.
    await act(async () => { f.deliver(delayed) }) // Resets the proceeding blocker.
    await act(async () => { f.pop() }) // Original proceed's business traversal.
    assert.equal(decisions.length, 1, 'approved drafts remain approved for the original POP transaction')
    assert.equal(f.router.state.location.pathname, '/library')
    assert.equal(f.router.state.historyAction, 'POP')
    assert.equal(f.cursor(), 0)
    assert.equal(f.stack.length, 3)
  } finally { f.dispose() }
})

test('hash-router replay asks settings and plugin drafts once, only after the owned POP settles', async () => {
  function Form() {
    const [dirty, setDirty] = useState(false)
    const plugin = usePluginDevLeaveGuard()
    useSettingsFormGuard({ label: '配置草稿', dirty, discard: () => setDirty(false) })
    return <button onClick={() => { setDirty(true); plugin.setNeedsConfirm(true) }}>编辑</button>
  }
  const f = await hashFixture(<Form />)
  const click = async (label: string) => act(async () => {
    const button = f.tree.root.findAllByType('button').find(value => value.children.includes(label))
    assert.ok(button, label); await button.props.onClick()
  })
  const titles = () => f.tree.root.findAllByType('h3').map(value => value.children.join(''))
  try {
    await click('编辑')
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    await act(async () => { await f.router.navigate('/next') })
    assert.deepEqual(titles(), [], 'owned viewing history is not a draft leave')
    await act(async () => { f.pop() })
    assert.deepEqual(titles(), ['有未保存的设置'])
    await click('放弃更改')
    assert.deepEqual(titles(), ['未安装的插件更改'])
    await click('仍要离开')
    assert.deepEqual(titles(), [])
    assert.equal(f.router.state.location.pathname, '/next')
    assert.equal(f.stack.length, 3)
    assert.deepEqual(f.goes, [-1])
  } finally { f.dispose() }
})

test('cancelling a deferred POP after a blocker reset cannot replay on a late event', async () => {
  const decisions: NavigationDecision[] = []
  function Draft() { useNavigationGuard(() => true, decision => decisions.push(decision)); return null }
  const f = await hashFixture(<Draft />)
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    const delayed = f.move(f.queued.shift()!)
    const navigation = f.router.navigate(-1)
    await act(async () => { f.pop(); await navigation })
    await act(async () => { f.pop(); f.deliver(delayed) })
    await act(async () => { decisions[0].reset(); decisions[0].proceed(); f.deliver(delayed); f.fallback() })
    assert.equal(f.router.state.location.pathname, '/detail')
    assert.equal(f.cursor(), 1)
    assert.deepEqual(f.queued, [])
    assert.equal(decisions.length, 1)
    await act(async () => { await f.router.navigate('/next') })
    assert.equal(decisions.length, 2, 'cancelled approval cannot skip a new attempt')
  } finally { f.dispose() }
})

test('unmount cancels the owned-traversal waiter before its event or fallback arrives', async () => {
  const f = await hashFixture()
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    await act(async () => { await f.router.navigate('/next') })
    act(() => f.tree.unmount())
    await act(async () => { f.pop(); f.fallback() })
    assert.equal(f.router.state.location.pathname, '/detail')
    assert.equal(f.cursor(), 1)
    assert.deepEqual(f.queued, [])
    assert.deepEqual(f.goes, [-1])
  } finally { f.dispose() }
})

test('a later business destination supersedes an earlier wait without replaying both', async () => {
  const f = await hashFixture()
  try {
    const token = f.overlay.open('image-preview', () => {})
    f.overlay.close(token)
    await act(async () => { await f.router.navigate('/obsolete'); await f.router.navigate('/next') })
    await act(async () => { f.pop() })
    assert.equal(f.router.state.location.pathname, '/next')
    assert.equal(f.stack.length, 3)
    assert.deepEqual(f.goes, [-1])
  } finally { f.dispose() }
})

test('a guard decision is single-use even while the next draft is prompting', async () => {
  const first: NavigationDecision[] = [], second: NavigationDecision[] = []
  function Drafts() {
    useNavigationGuard(() => true, decision => first.push(decision))
    useNavigationGuard(() => true, decision => second.push(decision))
    return null
  }
  const f = await hashFixture(<Drafts />)
  try {
    await act(async () => { await f.router.navigate('/next') })
    await act(async () => { first[0].proceed(); first[0].proceed() })
    assert.equal(first.length, 1)
    assert.equal(second.length, 1, 'repeated approval of the first draft must not re-prompt the second')
    await act(async () => { second[0].proceed() })
    assert.equal(f.router.state.location.pathname, '/next')
    assert.equal(f.stack.length, 3)
  } finally { f.dispose() }
})

test('settings and plugin guards compose through one router blocker, ignoring same-route viewing history', async () => {
  const oldWindow = globalThis.window, oldDocument = globalThis.document
  let pushes = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, history: { pushState() { pushes++ } }
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: {} }, activeElement: null } })
  function Form() {
    const [dirty, setDirty] = useState(false)
    const plugin = usePluginDevLeaveGuard()
    const navigate = useNavigate()
    useSettingsFormGuard({ label: '配置草稿', dirty, discard: () => setDirty(false) })
    return <>
      <button onClick={() => { setDirty(true); plugin.setNeedsConfirm(true) }}>编辑</button>
      <button onClick={() => plugin.requestLeave(() => navigate('/next'))}>主动离开</button>
    </>
  }
  const router = createMemoryRouter([{ path: '*', element:
    <OverlayHistoryProvider><NavigationGuardProvider><PluginDevLeaveGuardProvider><SettingsLeaveGuard>
      <Routes><Route path="/" element={<Form />} /><Route path="/next" element={<p>下一页</p>} /></Routes>
    </SettingsLeaveGuard></PluginDevLeaveGuardProvider></NavigationGuardProvider></OverlayHistoryProvider>
  }])
  let tree: TestRenderer.ReactTestRenderer | undefined
  const click = async (text: string) => act(async () => {
    const button = tree!.root.findAllByType('button').find(value => value.children.includes(text))
    assert.ok(button, text); await button.props.onClick()
  })
  const text = () => tree!.root.findAllByType('h3').map(value => value.children.join('')).join(' ')
  try {
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router} />) })
    await click('编辑')
    await act(async () => { await router.navigate('/', { state: { temporary: true } }) })
    assert.equal(tree!.root.findAllByProps({ role: 'dialog' }).length, 0, 'same-route temporary history is not a leave')
    await act(async () => { await router.navigate('/next') })
    assert.equal(router.state.location.pathname, '/')
    assert.match(text(), /未保存/)
    assert.doesNotMatch(text(), /未安装/)
    await click('放弃更改')
    assert.match(text(), /未安装/)
    await click('留在本页')
    assert.equal(router.state.location.pathname, '/')
    // The explicit plugin leave is still guarded; confirmation must not re-block
    // its immediate navigation using a stale needsConfirm ref.
    await click('主动离开'); await click('仍要离开')
    assert.equal(router.state.location.pathname, '/next')
    assert.equal(pushes, 0, 'guards never push an independent trap on mount or draft edits')
  } finally {
    act(() => tree?.unmount()); router.dispose()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: oldWindow })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: oldDocument })
  }
})
