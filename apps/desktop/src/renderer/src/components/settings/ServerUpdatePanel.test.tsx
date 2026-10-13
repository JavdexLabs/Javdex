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
    await act(async () => { button('检查更新').props.onClick() })
    assert.match(renderedText(tree!.root), /previous check failed/)
    await act(async () => { button('上传离线包').props.onClick() })
    assert.equal(button('检查更新').props.busy, false)
    assert.equal(button('检查更新').props.disabled, true)
    assert.equal(button('上传离线包').props.busy, true)
    assert.match(renderedText(tree!.root), /正在更新状态；上次结果：previous check failed/)
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
