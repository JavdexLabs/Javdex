import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { EMPTY_DESKTOP_SESSION } from '@shared/desktop/session'
import type { ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import { renderedText } from '../../test/renderedText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('client list pins the current client, preserves separate grants, and retains names when refresh fails', async () => {
  const previousWindow = globalThis.window
  let fail = false
  const result: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, platform: null, targetVersion: null, job: null,
    devices: [{ id: 'other', name: '客厅电脑', createdAt: '2026-10-15T01:00:00Z', current: false },
      { id: 'current', name: '工作电脑', createdAt: '2026-10-15T00:00:00Z', current: true },
      { id: 'another-grant', name: '客厅电脑', createdAt: '2026-10-15T02:00:00Z', current: false }] }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control: async () => {
    if (fail) throw new Error('连接中断，请重试')
    return result
  } } } } })
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  let tree: TestRenderer.ReactTestRenderer | undefined
  try {
    api.serverUpdate = window.api.serverUpdate
    const { default: Panel } = await import('./TrustedDevicesPanel')
    const { default: Button } = await import('../Button')
    await act(async () => { tree = TestRenderer.create(<DesktopSessionContext.Provider value={{
      session: { ...EMPTY_DESKTOP_SESSION, mode: 'remote', state: 'available', serverId: 's', catalogId: 'c' }, capabilities: {} as never, catalogReadsEnabled: true,
      reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
    }}><Panel /></DesktopSessionContext.Provider>) })
    assert.equal(tree!.root.findAllByType(Button).filter(button => renderedText(button) === '撤销授权').length, 2)
    const rows = tree!.root.findByProps({ 'aria-label': '可信客户端列表' }).findAllByType('li')
    assert.equal(rows.length, 3)
    assert.match(renderedText(rows[0]), /工作电脑当前客户端/)
    assert.equal(rows[0].findAllByType(Button).length, 0)
    assert.deepEqual(rows.map(row => row.findByType('time').props.dateTime), [
      '2026-10-15T00:00:00Z', '2026-10-15T01:00:00Z', '2026-10-15T02:00:00Z'
    ])
    assert.match(renderedText(tree!.root), /可信客户端3 个/)
    assert.doesNotMatch(renderedText(tree!.root), /设备|配对|pair/)
    fail = true
    await act(async () => { tree!.root.findAllByType(Button).find(button => renderedText(button) === '刷新')!.props.onClick() })
    const { default: Feedback } = await import('./SettingsFeedback')
    assert.equal(tree!.root.findByType(Feedback).props.detail, '连接中断，请重试')
    assert.match(renderedText(tree!.root), /客厅电脑/)
  } finally {
    act(() => tree?.unmount()); api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('late refresh failures cannot replace feedback or finish loading for a new session', async () => {
  const previousWindow = globalThis.window
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  const empty: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, platform: null, targetVersion: null, job: null, devices: [] }
  let rejectOld: (reason: Error) => void = () => {}
  let resolveNew: (result: ServerUpdateSnapshot) => void = () => {}
  let calls = 0
  const control = async (): Promise<ServerUpdateSnapshot> => {
    calls++
    if (calls === 2) return new Promise((_, reject) => { rejectOld = reject })
    if (calls === 3) return new Promise(resolve => { resolveNew = resolve })
    return empty
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control } } } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  try {
    api.serverUpdate = window.api.serverUpdate
    const { default: Panel } = await import('./TrustedDevicesPanel')
    const { default: Button } = await import('../Button')
    const render = (generation: number) => <DesktopSessionContext.Provider value={{
      session: { ...EMPTY_DESKTOP_SESSION, mode: 'remote', state: 'available', serverId: 's', catalogId: 'c', generation },
      capabilities: {} as never, catalogReadsEnabled: true, reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
    }}><Panel /></DesktopSessionContext.Provider>
    await act(async () => { tree = TestRenderer.create(render(1)) })
    const refresh = () => tree!.root.findAllByType(Button).find(button => renderedText(button) === '刷新')!
    await act(async () => { refresh().props.onClick() })
    await act(async () => { tree!.update(render(2)) })
    await act(async () => { rejectOld(new Error('旧连接失败')) })
    assert.equal(refresh().props.busy, true, 'the new session is still loading')
    assert.doesNotMatch(renderedText(tree!.root), /旧连接失败/)
    await act(async () => { resolveNew(empty) })
    assert.equal(refresh().props.busy, false)
  } finally {
    act(() => tree?.unmount()); api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
