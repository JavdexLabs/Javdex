import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import type { DesktopSession } from '@shared/desktop/session'
import DesktopSessionOverlay from './DesktopSessionOverlay'
import { DesktopSessionContext } from './DesktopSessionContext'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

function collectText(node: TestRenderer.ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map((child) => collectText(child as TestRenderer.ReactTestInstance)).join('')
}

function session(state: DesktopSession['state'], extra: Partial<DesktopSession> = {}): DesktopSession {
  return {
    state,
    mode: 'remote',
    catalogId: 'catalog-1',
    serverId: 'server-1',
    generation: 2,
    writerEpoch: 1,
    frozen: state === 'frozen',
    appVersion: '0.0.0-test',
    schemaVersion: 18,
    message: extra.message ?? null,
    ...extra
  }
}

function renderOverlay(current: DesktopSession, pathname = '/'): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={[pathname]}>
        <DesktopSessionContext.Provider
          value={{
            session: current,
            capabilities: {} as never,
            catalogReadsEnabled: current.state === 'available' || current.state === 'frozen',
            reconnect: async () => undefined,
            claimWriter: async () => {
              throw new Error('not used')
            }
          }}
        >
          <DesktopSessionOverlay />
        </DesktopSessionContext.Provider>
      </MemoryRouter>
    )
  })
  return renderer
}

afterEach(() => {
  TestRenderer.act(() => undefined)
})

it('shows a version mismatch page without exposing a writer token', () => {
  const text = collectText(renderOverlay(session('versionMismatch', { message: '桌面与服务器应用版本不一致' })).root)
  assert.match(text, /版本不一致/)
  assert.match(text, /打开连接设置/)
  assert.equal(text.includes('writer'), false)
  assert.equal(text.includes('Bearer'), false)
  assert.equal(text.includes('secret'), false)
})

it('asks for a one-time recovery token without showing a stored secret', () => {
  const text = collectText(renderOverlay(session('recoveryRequired')).root)
  assert.match(text, /领取写入凭据/)
  assert.match(text, /一次性领取令牌/)
  assert.equal(text.includes('secret'), false)
  assert.equal(text.includes('Bearer'), false)
})

it('keeps settings reachable while the catalog is disconnected', () => {
  const renderer = renderOverlay(session('disconnected'), '/settings/network/mode')
  assert.equal(collectText(renderer.root), '')
})

it('shows a frozen read-only banner', () => {
  const text = collectText(renderOverlay(session('frozen')).root)
  assert.match(text, /资料库已冻结/)
  assert.equal(text.includes('领取写入凭据'), false)
})
