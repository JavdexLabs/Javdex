import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import type { DesktopSession } from '@shared/desktop/session'
import type { DefaultPlayerDetectionResult, ThisComputerSettings, ThisComputerSettingsPatch } from '@shared/desktop/settings'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import SettingsLeaveGuard from '../../settings/SettingsLeaveGuard'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('detects a player into the draft only and retains the chosen path on failed detection', async () => {
  const previousWindow = globalThis.window
  let result: DefaultPlayerDetectionResult = { status: 'found', path: 'D:\\播放器\\Player.exe', extension: '.mp4' }
  let writes = 0
  const patches: ThisComputerSettingsPatch[] = []
  const settings = { mode: 'remote', remoteBaseUrl: 'http://localhost:8096', playerPath: null } as ThisComputerSettings
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: { thisComputer: {
      get: async () => settings,
      detectPlayer: async () => result,
      update: async (patch: ThisComputerSettingsPatch) => { writes++; patches.push(patch); return { settings: { ...settings, ...patch }, restartRequired: false } }
    } }
  } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  let router: ReturnType<typeof createMemoryRouter> | undefined
  try {
    const { default: Panel } = await import('./CatalogConnectionPanel')
    const { api } = await import('../../api')
    api.thisComputer = window.api.thisComputer
    router = createMemoryRouter([{ path: '*', element: <DesktopSessionContext.Provider value={{
      session: { state: 'available', mode: 'remote', generation: 1, catalogId: 'c', serverId: 's', frozen: false, writerEpoch: 1 } as DesktopSession,
      capabilities: {} as never, catalogReadsEnabled: true, reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
    }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider> }])
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router!} />) })
    assert.match(textOf(tree!.root), /播放服务端视频需设置/)
    assert.doesNotMatch(textOf(tree!.root), /播放设置（可选）/)
    await act(async () => { tree!.root.findByProps({ placeholder: 'http://192.168.1.10:8096' }).props.onChange({ target: { value: 'http://new-server:8096' } }) })
    const detect = () => tree!.root.findAllByType('button').find(node => textOf(node) === '使用系统默认播放器')!
    await act(async () => { detect().props.onClick() })
    assert.equal(writes, 0)
    assert.match(textOf(tree!.root), /已选择系统的 .mp4 默认播放器/)
    assert.equal(tree!.root.findByProps({ placeholder: '选择程序或输入绝对路径' }).props.value, 'D:\\播放器\\Player.exe')
    result = { status: 'unavailable', message: '未找到默认程序，请选择程序。' }
    await act(async () => { detect().props.onClick() })
    assert.match(textOf(tree!.root), /未找到默认程序/)
    assert.equal(tree!.root.findByProps({ placeholder: '选择程序或输入绝对路径' }).props.value, 'D:\\播放器\\Player.exe')
    await act(async () => { tree!.root.findAllByType('button').find(node => textOf(node) === '保存')!.props.onClick() })
    assert.equal(writes, 1)
    assert.deepEqual(patches, [{ playerPath: 'D:\\播放器\\Player.exe' }])
    assert.equal(tree!.root.findByProps({ placeholder: 'http://192.168.1.10:8096' }).props.value, 'http://new-server:8096')
    assert.match(textOf(tree!.root), /有未保存的更改/)
    assert.doesNotMatch(textOf(tree!.root), /保存后生效/)
  } finally {
    act(() => tree?.unmount())
    router?.dispose()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

function textOf(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string'
    ? node
    : node.children.map((child) => textOf(child as TestRenderer.ReactTestInstance)).join('')
}

it('saves remote-to-local mode without leaving a dirty draft or losing the server address', async () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const serverUrl = 'http://127.0.0.1:8096'
  let persisted = {
    mode: 'remote', remoteBaseUrl: serverUrl, playerPath: 'C:/player.exe',
    closeToTray: false, theme: 'dark', proxyUrl: '', proxyUrlEnabled: false,
    llmProxyUrl: '', llmProxyUrlEnabled: false
  } as ThisComputerSettings
  const writes: ThisComputerSettingsPatch[] = []
  let restarts = 0
  let releaseProbe: (() => void) | undefined
  let delayProbe = false
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener() {}, removeEventListener() {},
      api: { thisComputer: {
        get: async () => persisted,
        probe: async () => {
          if (delayProbe) await new Promise<void>(resolve => { releaseProbe = resolve })
          return ({
          status: 'reachable', message: '服务可达且版本匹配',
          serverVersion: 'test', serverId: 'server', catalogId: 'catalog'
        }) },
        restart: async () => { restarts += 1 },
        update: async (patch: ThisComputerSettingsPatch) => {
          writes.push(patch)
          persisted = { ...persisted, ...patch }
          return { settings: persisted, restartRequired: true }
        }
      } }
    }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { body: { style: {} }, activeElement: null }
  })
  let renderer: TestRenderer.ReactTestRenderer | undefined
  let router: ReturnType<typeof createMemoryRouter> | undefined
  try {
    const { default: CatalogConnectionPanel } = await import('./CatalogConnectionPanel')
    const { api } = await import('../../api')
    api.thisComputer = window.api.thisComputer
    const { default: SelectControl } = await import('../SelectControl')
    const session: DesktopSession = {
      state: 'available', mode: 'remote', catalogId: 'catalog', serverId: 'server',
      remoteBaseUrl: serverUrl,
      generation: 1, writerEpoch: 1, frozen: false, appVersion: 'test',
      schemaVersion: 1, message: null
    }
    const activeRouter = createMemoryRouter([{ path: '*', element: (
      <DesktopSessionContext.Provider value={{
        session, capabilities: { migrateCatalog: { allowed: false } } as never,
        catalogReadsEnabled: true, reconnect: async () => undefined,
        claimWriter: async () => { throw new Error('not used') }
      }}>
        <SettingsLeaveGuard>
          <Routes>
            <Route path="/settings" element={<CatalogConnectionPanel />} />
            <Route path="/next" element={<p>下一页</p>} />
          </Routes>
        </SettingsLeaveGuard>
      </DesktopSessionContext.Provider>
    ) }], { initialEntries: ['/settings'] })
    router = activeRouter
    await act(async () => { renderer = TestRenderer.create(<RouterProvider router={activeRouter} />) })
    act(() => renderer!.root.findByType(SelectControl).props.onChange({ target: { value: 'local' } }))
    assert.match(textOf(renderer!.root), /有未保存的更改/)
    const save = renderer!.root.findAllByType('button').find((button) => button.children.includes('应用连接'))!
    await act(async () => { save.props.onClick() })
    assert.deepEqual(writes, [{ mode: 'local', remoteBaseUrl: serverUrl }])
    assert.equal(persisted.mode, 'local')
    assert.match(textOf(renderer!.root), /已保存 · 重启后生效/)
    assert.match(textOf(renderer!.root), /当前使用：远程资料库.*重启后使用：本地资料库/)
    assert.doesNotMatch(textOf(renderer!.root), /有未保存的更改/)
    await act(async () => { await router!.navigate('/next') })
    assert.equal(router.state.location.pathname, '/next')
    await act(async () => { await router!.navigate('/settings') })
    assert.equal(renderer!.root.findByType(SelectControl).props.value, 'local')
    assert.match(textOf(renderer!.root), /当前使用：远程资料库.*重启后使用：本地资料库/)
    act(() => renderer!.root.findByType(SelectControl).props.onChange({ target: { value: 'remote' } }))
    assert.equal(renderer!.root.findByProps({ placeholder: 'http://192.168.1.10:8096' }).props.value, serverUrl)
    const probe = renderer!.root.findAllByType('button').find((button) => button.children.includes('测试连接'))!
    await act(async () => { probe.props.onClick() })
    assert.match(textOf(renderer!.root), /服务可达，版本匹配/)
    assert.equal(renderer!.root.findAllByType('button').filter(button => textOf(button) === '查看详情' && !button.props['aria-hidden']).length, 0)
    delayProbe = true
    await act(async () => { probe.props.onClick() })
    assert.equal(textOf(probe), '测试连接')
    assert.equal(probe.props['aria-busy'], true)
    assert.match(textOf(renderer!.root), /正在测试当前输入/)
    await act(async () => { releaseProbe!() })
    assert.equal(probe.props['aria-busy'], false)

    assert.match(textOf(renderer!.root), /有未保存的更改/)
    assert.equal(renderer!.root.findAllByType('button').find((button) => textOf(button) === '立即重启')!.props.disabled, true)
    act(() => renderer!.root.findByType(SelectControl).props.onChange({ target: { value: 'local' } }))
    const restart = renderer!.root.findAllByType('button').find((button) => textOf(button) === '立即重启')!
    assert.equal(restart.props.disabled, false)
    await act(async () => { restart.props.onClick() })
    assert.equal(restarts, 1)
  } finally {
    act(() => renderer?.unmount())
    router?.dispose()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  }
})
