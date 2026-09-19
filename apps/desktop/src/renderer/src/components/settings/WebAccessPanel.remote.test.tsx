import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import { DESKTOP_CAPABILITY_ACTIONS, type DesktopCapabilityMap } from '@shared/desktop/capabilities'
import type { DesktopSession } from '@shared/desktop/session'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('opens remote pairing through the existing panel and removes controls when the session freezes', async () => {
  const previous = globalThis.window
  const previousFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  let status = { enabled: true, running: true, port: 8096, username: 'server-viewer', hasPassword: true,
    urls: ['http://server.test:8096'], devices: [], sessions: 0, pairingUntil: 0, pairingActivity: [], error: null }
  const calls: string[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { webAccess: {
    status: async () => status,
    pairOpen: async () => { calls.push('open'); status = { ...status, pairingUntil: Date.now() + 300000 }; return status },
    pairInspect: async (code: string) => { calls.push(code); return { name: 'Remote phone', expires: Date.now() + 60000, remember: true } },
    pairDecide: async (code: string, approve: boolean) => { calls.push(`${code}:${approve}`); return status }
  } } } })
  let renderer: TestRenderer.ReactTestRenderer | undefined
  try {
    const { default: Panel } = await import('./WebAccessPanel')
    const render = (state: DesktopSession['state']) => {
      const session = { mode: 'remote', state, catalogId: 'catalog', serverId: 'server', generation: 1,
        appVersion: '0.7.1', writerEpoch: 1, frozen: state === 'frozen' } as DesktopSession
      return <DesktopSessionContext.Provider value={{ session, capabilities: Object.fromEntries(DESKTOP_CAPABILITY_ACTIONS.map(action => [action, { action, allowed: state === 'available', reason: state === 'available' ? 'available' : state === 'frozen' ? 'catalogFrozen' : 'disconnected' }])) as DesktopCapabilityMap,
        catalogReadsEnabled: state === 'available' || state === 'frozen', reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>
    }
    await act(async () => { renderer = TestRenderer.create(render('available')) })
    assert.equal(renderer!.root.findAllByType('input').some(input => input.props['aria-label'] === '端口'), false)
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('server.test:8096'))
    const button = (name: string) => renderer!.root.findAllByType('button').find(item => item.children.includes(name))!
    await act(async () => button('开启配对').props.onClick())
    const code = renderer!.root.findAllByType('input').find(input => input.props.autoComplete === 'one-time-code')!
    act(() => code.props.onChange({ target: { value: '123456' } }))
    await act(async () => button('核对设备').props.onClick())
    await act(async () => button('允许登录').props.onClick())
    assert.deepEqual(calls, ['open', '123456', '123456:true'])
    await act(async () => renderer!.update(render('frozen')))
    assert.equal(renderer!.root.findAllByType('button').length, 0)
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('资料库已冻结'))
    await act(async () => renderer!.update(render('disconnected')))
    assert.ok(JSON.stringify(renderer!.toJSON()).includes('请先连接服务端'))
  } finally {
    if (renderer) act(() => renderer!.unmount())
    globalThis.requestAnimationFrame = previousFrame
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
  }
})
