import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { EMPTY_DESKTOP_SESSION } from '@shared/desktop/session'
import type { ServerUpdateCommand, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import { renderedText } from '../../test/renderedText'

const initial: ServerUpdateSnapshot = { protocolVersion: 1, paired: true, serverId: 's', catalogId: 'c', currentVersion: '0.8.0', platform: 'linux/amd64', targetVersion: '0.9.0-beta.1', job: null }
const session = { ...EMPTY_DESKTOP_SESSION, state: 'versionMismatch' as const, mode: 'remote' as const, serverId: 's', catalogId: 'c', appVersion: '0.8.0', desktopAppVersion: '0.9.0-beta.1' }
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

for (const offline of [false, true]) test(`recovery targets this desktop without upgrade backup (offline=${offline})`, async () => {
  const previousWindow = globalThis.window
  const calls: ServerUpdateCommand[] = []
  const prepared: ServerUpdateSnapshot = { ...initial, job: { id: '33333333-3333-4333-8333-333333333333', version: session.desktopAppVersion, phase: 'prepared', receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: null } }
  const control = async (command: ServerUpdateCommand): Promise<ServerUpdateSnapshot> => {
    calls.push(command)
    if (command.action === 'prepare' || command.action === 'import') return prepared
    if (command.action === 'install') return { ...prepared, job: { ...prepared.job!, phase: 'verifying' } }
    return initial
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control } } } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  try {
    api.serverUpdate = window.api.serverUpdate
    const [{ default: Panel }, { default: Button }, { default: Modal }] = await Promise.all([import('./ServerUpdatePanel'), import('../Button'), import('../Modal')])
    await act(async () => { tree = TestRenderer.create(<DesktopSessionContext.Provider value={{ session, capabilities: {} as never, catalogReadsEnabled: false, reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>) })
    const button = (label: string) => tree!.root.findAllByType(Button).find(node => renderedText(node) === label)!
    assert.equal(tree!.root.findAllByProps({ role: 'switch' }).length, 0)
    assert.doesNotMatch(renderedText(tree!.root), /更新授权|已配对|检查更新/)
    await act(async () => { button(offline ? '上传离线包升级' : '在线升级').props.onClick() })
    const commands = calls.filter(item => item.action !== 'status')
    assert.deepEqual(commands, offline ? [{ action: 'import', targetVersion: session.desktopAppVersion }] : [{ action: 'check', targetVersion: session.desktopAppVersion }, { action: 'prepare', targetVersion: session.desktopAppVersion }])
    await act(async () => { button('确认升级').props.onClick() })
    assert.equal(calls.some(item => item.action === 'install'), false)
    await act(async () => { await tree!.root.findByType(Modal).props.onConfirm() })
    assert.deepEqual(calls.at(-1), { action: 'install', jobId: prepared.job!.id, targetVersion: session.desktopAppVersion })
    const progress = tree!.root.findByProps({ 'aria-label': '升级进度' })
    assert.equal(renderedText(progress).includes('备份资料库'), false)
  } finally {
    act(() => tree?.unmount())
    api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('same and newer server versions do not expose the recovery card', async () => {
  const previousWindow = globalThis.window
  let current = initial
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control: async () => current } } } })
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  const { default: Panel } = await import('./ServerUpdatePanel')
  try {
    api.serverUpdate = window.api.serverUpdate
    for (const version of [session.desktopAppVersion, '0.9.1']) {
      current = { ...initial, currentVersion: version }
      let tree: TestRenderer.ReactTestRenderer | undefined
      try {
        await act(async () => { tree = TestRenderer.create(<DesktopSessionContext.Provider value={{ session: { ...session, appVersion: version }, capabilities: {} as never, catalogReadsEnabled: false, reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>) })
        assert.equal(tree!.toJSON(), null)
      } finally { act(() => tree?.unmount()) }
    }
  } finally {
    api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('retry preserves error details and shows busy feedback on the actual action', async () => {
  const previousWindow = globalThis.window
  let finish: (value: ServerUpdateSnapshot) => void = () => {}
  const pending = new Promise<ServerUpdateSnapshot>(resolve => { finish = resolve })
  const control = async (command: ServerUpdateCommand): Promise<ServerUpdateSnapshot> => {
    if (command.action === 'check') throw new Error('previous check failed')
    if (command.action === 'import') return pending
    return initial
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control } } } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  try {
    api.serverUpdate = window.api.serverUpdate
    const { default: Panel } = await import('./ServerUpdatePanel')
    const { default: Button } = await import('../Button')
    await act(async () => { tree = TestRenderer.create(<DesktopSessionContext.Provider value={{ session, capabilities: {} as never, catalogReadsEnabled: false, reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>) })
    const button = (label: string) => tree!.root.findAllByType(Button).find(node => renderedText(node) === label)!
    await act(async () => { button('在线升级').props.onClick() })
    assert.match(renderedText(tree!.root), /previous check failed/)
    await act(async () => { button('上传离线包升级').props.onClick() })
    assert.equal(button('在线升级').props.busy, false)
    assert.equal(button('在线升级').props.disabled, true)
    assert.equal(button('上传离线包升级').props.busy, true)
    assert.match(renderedText(tree!.root), /previous check failed/)
    const { default: Feedback } = await import('./SettingsFeedback')
    assert.equal(tree!.root.findByType(Feedback).props.detail, 'previous check failed')
    await act(async () => { finish(initial); await pending })
    assert.doesNotMatch(renderedText(tree!.root), /previous check failed/)
  } finally {
    act(() => tree?.unmount())
    api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

test('completed update keeps retrying a disconnected reconnect until the matching session is available', async () => {
  const previousWindow = globalThis.window
  const complete = { ...initial, currentVersion: session.desktopAppVersion, targetVersion: null, job: { id: 'job', version: session.desktopAppVersion, phase: 'complete' as const, receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: null } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control: async () => complete } } } })
  let refresh: (() => void) | undefined
  const interval = globalThis.setInterval
  const captured = mock.method(globalThis, 'setInterval', (callback: () => void, milliseconds?: number) => { refresh = callback; return interval(callback, milliseconds) })
  let tree: TestRenderer.ReactTestRenderer | undefined
  let reconnects = 0
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  try {
    api.serverUpdate = window.api.serverUpdate
    const { default: Panel } = await import('./ServerUpdatePanel')
    function Harness(): JSX.Element {
      const [current, setCurrent] = React.useState<import('@shared/desktop/session').DesktopSession>(session)
      const reconnect = React.useCallback(async () => {
        reconnects++
        if (reconnects === 2) setCurrent(previous => ({ ...previous, state: 'available', appVersion: session.desktopAppVersion }))
      }, [])
      return <DesktopSessionContext.Provider value={{ session: current, capabilities: {} as never, catalogReadsEnabled: current.state === 'available', reconnect, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>
    }
    await act(async () => { tree = TestRenderer.create(<Harness />) })
    assert.equal(reconnects, 1)
    await act(async () => { refresh!() })
    assert.equal(reconnects, 2)
    await act(async () => { refresh!() })
    assert.equal(reconnects, 2, 'healthy session does not reconnect again')
  } finally {
    act(() => tree?.unmount())
    captured.mock.restore()
    api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
