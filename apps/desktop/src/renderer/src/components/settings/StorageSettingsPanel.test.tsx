import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { DesktopSession } from '@shared/desktop/session'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

function textOf(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string'
    ? node
    : node.children.map((child) => textOf(child as TestRenderer.ReactTestInstance)).join('')
}

it('shows the server image path without exposing local image actions in remote mode', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {} } })
  const { default: StorageSettingsPanel } = await import('./StorageSettingsPanel')
  const session: DesktopSession = {
    state: 'available', mode: 'remote', catalogId: 'catalog', serverId: 'server',
    generation: 1, writerEpoch: 1, frozen: false, appVersion: 'test',
    schemaVersion: 1, remoteImagesDir: '/data/images', message: null
  }
  const settings = {
    mediaAssetsPath: 'C:/local/images', mediaAssetsResolvedPath: 'C:/local/images',
    assetEncryption: true
  } as SettingsSnapshot
  let tree: TestRenderer.ReactTestRenderer | undefined
  act(() => {
    tree = TestRenderer.create(
      <DesktopSessionContext.Provider value={{
        session, capabilities: {} as never, catalogReadsEnabled: true,
        reconnect: async () => undefined,
        claimWriter: async () => { throw new Error('not used') }
      }}>
        <StorageSettingsPanel
          settings={settings}
          tab="assets"
          storageBusy={false}
          onPickMediaAssetsPath={() => { throw new Error('local action invoked') }}
          onResetMediaAssetsPath={() => { throw new Error('local action invoked') }}
          onToggleAssetEncryption={() => { throw new Error('local action invoked') }}
          onExportBlockingChange={() => undefined}
        />
      </DesktopSessionContext.Provider>
    )
  })
  try {
    const content = textOf(tree!.root)
    assert.match(content, /\/data\/images/)
    assert.doesNotMatch(content, /C:\/local\/images|恢复默认|启用图片加密|关闭图片加密/)
    assert.equal(tree!.root.findAllByType('button').length, 0)
  } finally {
    act(() => tree?.unmount())
  }
})
