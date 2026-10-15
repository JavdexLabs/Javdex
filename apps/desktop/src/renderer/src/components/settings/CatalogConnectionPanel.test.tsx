import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { createMemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import type { DesktopSession } from '@shared/desktop/session'
import { EMPTY_DESKTOP_SESSION } from '@shared/desktop/session'
import type { DefaultPlayerDetectionResult, RemoteConnectionProbeResult, ThisComputerSettings, ThisComputerSettingsPatch } from '@shared/desktop/settings'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import LeaveGuard from '../../settings/SettingsLeaveGuard'
import { OverlayHistoryProvider } from '../../interaction/OverlayHistoryContext'
import { NavigationGuardProvider } from '../../interaction/NavigationGuard'
import { renderedText } from '../../test/renderedText'
import type { ServerConnectionSummary, ServerUpdateCommand, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'

function SettingsLeaveGuard({ children }: { children: React.ReactNode }): JSX.Element {
  return <OverlayHistoryProvider><NavigationGuardProvider><LeaveGuard>{children}</LeaveGuard></NavigationGuardProvider></OverlayHistoryProvider>
}

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('keeps mode choices visible and replaces pairing inputs with persisted connection details until unpaired', async () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: {}
  } })
  const { api } = await import('../../api')
  const previousComputer = api.thisComputer
  const previousUpdate = api.serverUpdate
  const { default: Panel } = await import('./CatalogConnectionPanel')
  const { default: SettingsFormActions } = await import('./SettingsFormActions')
  let settings = { mode: 'local', remoteBaseUrl: null, playerPath: null } as ThisComputerSettings
  const target: ServerConnectionSummary = { remoteBaseUrl: 'https://example.test', serverId: 'server', catalogId: 'catalog' }
  let stored: ServerConnectionSummary | null = null
  let connectionRestartRequired = false
  let session: DesktopSession = { ...EMPTY_DESKTOP_SESSION, state: 'available', mode: 'local' }
  const actions: string[] = []
  let finishReading: (() => void) | undefined
  let finishPairing: (() => void) | undefined
  let finishProbe: (() => void) | undefined
  let delayReading = true
  let failForget = true
  let failReading = false
  let failManualSave = true
  let focusedPairings = 0
  const result = (): ServerUpdateSnapshot => ({ protocolVersion: 1, paired: Boolean(stored), connection: stored, connectionRestartRequired,
    serverId: stored?.serverId ?? null, catalogId: stored?.catalogId ?? null,
    currentVersion: null, targetVersion: null, platform: null, job: null })
  const computer: typeof api.thisComputer = { get: async () => settings,
    probe: async () => new Promise<RemoteConnectionProbeResult>(resolve => {
      finishProbe = () => resolve({ status: 'reachable', message: 'old manual probe result', serverVersion: 'test', serverId: 'old-server', catalogId: 'old-catalog' })
    }), restart: async () => {}, pickPlayer: async () => null,
    detectPlayer: async () => ({ status: 'unavailable', message: 'unused in this fixture' }),
    update: async (patch: ThisComputerSettingsPatch) => {
    if (failManualSave) throw new Error('manual settings save failed')
    settings = { ...settings, ...patch }; return { settings, restartRequired: true }
  } }
  const update = { control: async (command: ServerUpdateCommand) => {
    actions.push(command.action)
    if (command.action === 'connectionStatus' && failReading) throw new Error('cannot read saved pairing')
    if (command.action === 'connectionStatus' && delayReading) await new Promise<void>(resolve => { finishReading = resolve })
    if (command.action === 'connect') {
      await new Promise<void>(resolve => { finishPairing = resolve })
      stored = target
      connectionRestartRequired = true
      settings = { ...settings, mode: 'remote', remoteBaseUrl: target.remoteBaseUrl }
    }
    if (command.action === 'forgetConnection') {
      if (failForget) throw new Error('secure storage unavailable')
      stored = null
      connectionRestartRequired = true
    }
    return result()
  } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: { thisComputer: computer, serverUpdate: update }
  } })
  api.thisComputer = computer; api.serverUpdate = update
  let tree: TestRenderer.ReactTestRenderer | undefined
  let router: ReturnType<typeof createMemoryRouter> | undefined
  const mount = async () => {
    router = createMemoryRouter([{ path: '*', element: <DesktopSessionContext.Provider value={{
      session, capabilities: {} as never, catalogReadsEnabled: true, reconnect: async () => {},
      claimWriter: async () => { throw new Error('unused') }
    }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider> }])
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router!} />, {
      createNodeMock: element => element.type === 'input' ? { focus: () => { focusedPairings++ } } : null
    }) })
  }
  const button = (name: string) => tree!.root.findAllByType('button').find(node => textOf(node) === name)!
  const mode = (name: string) => tree!.root.findAllByType('button').find(node => node.props.role === 'radio' && node.props['aria-label'] === name)!
  const inputs = () => tree!.root.findAllByType('textarea').filter(node => node.props['aria-label'] === '写入授权信息')
  try {
    await mount()
    assert.equal(inputs().length, 0, 'local mode has no pairing input')
    assert.equal(tree!.root.findAllByType('input').filter(node => node.props.placeholder === 'https://192.168.1.10:8096').length, 0)
    assert.doesNotMatch(textOf(tree!.root), /服务端配对|从本机资料库导入/)
    assert.equal(mode('本地资料库').props['aria-checked'], true)
    assert.ok(mode('远程资料库'))
    assert.equal(tree!.root.findAllByType('summary').some(node => /手动连接与本地模式/.test(textOf(node))), false)
    act(() => mode('远程资料库').props.onClick())
    const currentStatus = tree!.root.findAllByType('section').find(node => node.props['aria-label'] === '当前连接')!
    assert.match(textOf(currentStatus), /本地资料库/)
    assert.doesNotMatch(textOf(currentStatus), /远程资料库/, 'the remote draft does not change the active local session')
    assert.ok(tree!.root.findAllByType('section').some(node => node.props['aria-label'] === '资料库配置'))
    assert.equal(inputs().length, 0, 'loading persisted pairing does not flash an empty form')
    await act(async () => { finishReading!() })
    delayReading = false
    assert.equal(inputs().length, 1)
    assert.equal(tree!.root.findAllByType('button').some(node => node.props['aria-label'] === '配对连接'), false)
    act(() => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'https://192.168.1.10:8096')!.props.onChange({ target: { value: target.remoteBaseUrl } }))
    await act(async () => { tree!.root.findAllByType(SettingsFormActions)[0].props.onSave() })
    assert.equal(tree!.root.findAllByType(SettingsFormActions)[0].props.error, 'manual settings save failed')
    failManualSave = false
    await act(async () => { button('测试连接').props.onClick() })
    act(() => inputs()[0].props.onChange({ target: { value: 'a'.repeat(64) } }))
    act(() => mode('远程资料库').props.onClick())
    assert.equal(inputs()[0].props.value, 'a'.repeat(64), 'clicking the selected mode retains the pairing draft')
    await act(async () => { const submit = tree!.root.findByProps({ 'aria-label': '写入授权', 'aria-busy': false }).props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }) })
    assert.equal(actions.filter(action => action === 'connect').length, 1, 'duplicate clicks submit a single pairing request')
    assert.equal(mode('本地资料库').props.disabled, true)
    await act(async () => { finishProbe!() })
    assert.doesNotMatch(textOf(tree!.root), /old manual probe result/, 'a late manual probe cannot replace feedback while pairing a new target')
    await act(async () => { finishPairing!() })
    assert.equal(inputs().length, 0)
    assert.match(textOf(tree!.root), /已保存此电脑的管理授权/)
    assert.match(textOf(tree!.root), /重启后生效/)
    assert.equal(tree!.root.findAllByType(SettingsFormActions)[0].props.dirty, false, 'pairing accepts the saved remote target even from a local draft')
    assert.equal(tree!.root.findAllByType(SettingsFormActions)[0].props.error, null, 'successful pairing clears an obsolete manual-save error')
    assert.ok(button('取消配对'))
    assert.equal(tree!.root.findAllByType('a').some(node => textOf(node) === '备份与恢复'), false, 'saving pairing alone does not show the import tip')

    act(() => tree!.unmount()); router!.dispose()
    await mount()
    assert.equal(inputs().length, 0, 'reopening before restart still shows the saved pairing')
    assert.match(textOf(tree!.root), /重启后生效/)
    act(() => tree!.unmount()); router!.dispose()
    connectionRestartRequired = false
    session = { ...session, mode: 'remote', remoteBaseUrl: target.remoteBaseUrl, serverId: target.serverId, catalogId: target.catalogId }
    await mount()
    assert.equal(inputs().length, 0, 'saved pairing survives reopening the settings page')
    assert.match(textOf(tree!.root), /已授权/)
    assert.ok(tree!.root.findAllByType('a').some(node => textOf(node) === '备份与恢复' && node.props.draggable === false))
    for (const state of ['starting', 'disconnected', 'authInvalid'] as const) {
      act(() => tree!.unmount()); router!.dispose()
      session = { ...session, state, serverId: state === 'authInvalid' ? target.serverId : null, catalogId: null }
      await mount()
      const status = tree!.root.findAllByType('section').find(node => node.props['aria-label'] === '当前连接')!
      const authorization = status.findAllByType('dt').find(node => textOf(node) === '写入授权')!
      assert.equal(textOf(authorization.parent!.findByType('dd')), state === 'authInvalid' ? '授权已失效' : '待连接确认')
      assert.equal(tree!.root.findAllByType('aside').some(node => node.props['aria-label'] === '从本机资料库导入提示'), false)
    }
    act(() => tree!.unmount()); router!.dispose()
    session = { ...session, state: 'available', serverId: target.serverId, catalogId: 'restored-catalog' }
    await mount()
    assert.match(textOf(tree!.root), /已授权/, 'a restored catalog on the authenticated server retains device authorization')
    await act(async () => { button('取消配对').props.onClick() })
    assert.ok(button('取消配对'), 'failed cancellation keeps the paired summary')
    assert.equal(inputs().length, 0)
    assert.match(textOf(tree!.root), /服务端配对操作失败/)
    failForget = false
    await act(async () => { button('取消配对').props.onClick() })
    assert.equal(inputs().length, 1)
    assert.equal(inputs()[0].props.value, '', 'one-time pairing input is cleared')
    assert.equal(focusedPairings, 1, 'successful cancellation returns focus to the server address')
    assert.match(textOf(tree!.root), /已取消配对，重启后生效/)
    act(() => mode('本地资料库').props.onClick())
    assert.equal(inputs().length, 0, 'local draft hides remote controls even while the active session remains remote')
    assert.equal(tree!.root.findAllByType('a').some(node => textOf(node) === '备份与恢复'), false)
    act(() => mode('远程资料库').props.onClick())
    assert.equal(inputs().length, 1)
    assert.equal(tree!.root.findAllByType('input').find(node => node.props.placeholder === 'https://192.168.1.10:8096')!.props.value, target.remoteBaseUrl)
    act(() => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'https://192.168.1.10:8096')!.props.onChange({ target: { value: 'https://discarded.example.test' } }))
    await act(async () => { button('测试连接').props.onClick() })
    act(() => tree!.root.findAllByType(SettingsFormActions)[0].props.onCancel())
    await act(async () => { finishProbe!() })
    assert.doesNotMatch(textOf(tree!.root), /old manual probe result/, 'discarding a connection draft invalidates its pending probe')
    act(() => tree!.unmount()); router!.dispose()
    failReading = true
    await mount()
    assert.equal(inputs().length, 0, 'unreadable saved pairing is not treated as unpaired')
    assert.ok(button('重新读取'))
    failReading = false
    await act(async () => { button('重新读取').props.onClick() })
    assert.equal(tree!.root.findAllByType('textarea').filter(node => node.props['aria-label'] === '写入授权信息').length, 1)
  } finally {
    act(() => tree?.unmount()); router?.dispose()
    api.thisComputer = previousComputer; api.serverUpdate = previousUpdate
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

it('keeps manual authorization with its server and shows import guidance only after the active target is authorized', async () => {
  const previousWindow = globalThis.window
  const { api } = await import('../../api')
  const previousComputer = api.thisComputer, previousUpdate = api.serverUpdate
  const { default: Panel } = await import('./CatalogConnectionPanel')
  const target = { remoteBaseUrl: 'https://example.test', serverId: 'server', catalogId: 'catalog' }
  let settings = { mode: 'remote', remoteBaseUrl: target.remoteBaseUrl, playerPath: null } as ThisComputerSettings
  const initialSession: DesktopSession = { ...EMPTY_DESKTOP_SESSION, ...target, mode: 'remote', state: 'recoveryRequired', writerEpoch: 1 }
  let updateSession!: React.Dispatch<React.SetStateAction<DesktopSession>>
  let claims = 0, pairings = 0
  api.thisComputer = {
    get: async () => settings,
    probe: async () => ({ status: 'reachable', message: '服务可达，版本匹配', serverVersion: 'test', serverId: target.serverId, catalogId: target.catalogId }),
    update: async patch => { settings = { ...settings, ...patch }; return { settings, restartRequired: true } },
    restart: async () => {}, pickPlayer: async () => null, detectPlayer: async () => ({ status: 'unavailable', message: 'unused' })
  }
  const empty: ServerUpdateSnapshot = { protocolVersion: 1, paired: false, serverId: null, catalogId: null, currentVersion: null, targetVersion: null, platform: null, job: null, connection: null }
  api.serverUpdate = { control: async command => {
    if (command.action === 'connect') { pairings++; return { ...empty, paired: true, connection: target, connectionRestartRequired: true } }
    return empty
  } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {}, api: { thisComputer: api.thisComputer, serverUpdate: api.serverUpdate } } })
  function Harness(): JSX.Element {
    const [session, setSession] = React.useState(initialSession)
    updateSession = setSession
    return <DesktopSessionContext.Provider value={{ session, capabilities: {} as never, catalogReadsEnabled: true, reconnect: async () => {}, claimWriter: async () => {
      claims++
      throw new Error('legacy claim must not be called')
    } }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider>
  }
  const router = createMemoryRouter([{ path: '*', element: <Harness /> }])
  let tree: TestRenderer.ReactTestRenderer | undefined
  const button = (label: string) => tree!.root.findAllByType('button').find(node => textOf(node) === label)!
  const input = () => tree!.root.findAllByType('textarea').find(node => node.props['aria-label'] === '写入授权信息')!
  const address = () => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'https://192.168.1.10:8096')!
  const tip = () => tree!.root.findAllByType('aside').filter(node => node.props['aria-label'] === '从本机资料库导入提示')
  const submit = () => tree!.root.findByProps({ 'aria-label': '写入授权', 'aria-busy': false }).props.onSubmit({ preventDefault() {} })
  try {
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router} />) })
    assert.ok(address()); assert.ok(input())
    assert.equal(tree!.root.findAllByType('textarea').filter(node => node.props['aria-label'] === '写入授权信息').length, 1, 'manual connection has one token input and no method switch')
    assert.equal(tree!.root.findAllByType('summary').some(node => /旧部署的令牌授权/.test(textOf(node))), false)
    assert.equal(tip().length, 0)
    await act(async () => { button('测试连接').props.onClick() })
    assert.match(textOf(tree!.root), /服务可达，版本匹配/)
    assert.equal(tip().length, 0, 'a successful public handshake is not an authorized connection')

    act(() => input().props.onChange({ target: { value: 'not-a-token' } }))
    await act(async () => { submit() })
    assert.equal(pairings, 0, 'invalid tokens never reach the main process')
    act(() => address().props.onChange({ target: { value: 'https://other.test' } }))
    assert.equal(input().props.value, '', 'changing address clears the token')
    act(() => address().props.onChange({ target: { value: target.remoteBaseUrl } }))
    assert.equal(claims, 0, 'manual authorization uses the unified token endpoint')
    await act(async () => { updateSession(current => ({ ...current, state: 'available' })) })
    assert.equal(tip().length, 1)
    assert.equal(tree!.root.findAllByType('textarea').filter(node => node.props['aria-label'] === '写入授权信息').length, 0, 'an authenticated session shows authorization status in the same form')
    for (const state of ['starting', 'disconnected', 'claimRequired', 'recoveryRequired', 'authInvalid', 'versionMismatch', 'frozen'] as const) {
      await act(async () => { updateSession(current => ({ ...current, state })) })
      assert.equal(tip().length, 0, `${state} does not show migration guidance`)
    }
    await act(async () => { updateSession(current => ({ ...current, state: 'available' })) })
    assert.equal(tip().length, 1)
    act(() => address().props.onChange({ target: { value: 'https://other.test' } }))
    assert.equal(tip().length, 0, 'guidance belongs to the active server, not an unsaved destination')
    act(() => address().props.onChange({ target: { value: target.remoteBaseUrl } }))
    await act(async () => { updateSession(current => ({ ...current, state: 'recoveryRequired' })) })
    act(() => input().props.onChange({ target: { value: 'b'.repeat(64) } }))
    await act(async () => { submit() })
    assert.equal(pairings, 1, 'manual authorization submits the token for the entered address')
    assert.match(textOf(tree!.root), /已保存此电脑的管理授权/)
    assert.equal(tip().length, 0, 'pairing still waits for the authenticated session after restart')
  } finally {
    act(() => tree?.unmount()); router.dispose()
    api.thisComputer = previousComputer; api.serverUpdate = previousUpdate
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

it('detects a player into the draft only and retains the chosen path on failed detection', async () => {
  const previousWindow = globalThis.window
  let result: DefaultPlayerDetectionResult = { status: 'found', path: 'D:\\播放器\\Player.exe', extension: '.mp4' }
  let writes = 0
  const patches: ThisComputerSettingsPatch[] = []
  const settings = { mode: 'remote', remoteBaseUrl: 'http://localhost:8096', playerPath: null, playerPreference: 'external' } as ThisComputerSettings
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
    assert.match(textOf(tree!.root), /请先选择或输入程序路径/)
    assert.doesNotMatch(textOf(tree!.root), /播放设置（可选）/)
    await act(async () => { tree!.root.findByProps({ placeholder: 'https://192.168.1.10:8096' }).props.onChange({ target: { value: 'http://new-server:8096' } }) })
    const detect = () => tree!.root.findAllByType('button').find(node => node.props['aria-label'] === '使用系统默认播放器')!
    await act(async () => { detect().props.onClick() })
    assert.equal(writes, 0)
    assert.match(textOf(tree!.root), /已选择系统的 .mp4 默认播放器/)
    assert.equal(tree!.root.findByProps({ placeholder: '选择程序或输入绝对路径' }).props.value, 'D:\\播放器\\Player.exe')
    result = { status: 'unavailable', message: '未找到默认程序，请选择程序。' }
    await act(async () => { detect().props.onClick() })
    act(() => tree!.root.findAllByType('button').find(node => node.props.title === '保存失败')!.props.onClick())
    assert.match(textOf(tree!.root), /未找到默认程序/)
    assert.equal(tree!.root.findByProps({ placeholder: '选择程序或输入绝对路径' }).props.value, 'D:\\播放器\\Player.exe')
    act(() => tree!.root.findAllByType('button').find(node => node.props['aria-pressed'] !== undefined && textOf(node) === '内置播放器')!.props.onClick())
    const { default: SettingsSwitchRow } = await import('../SettingsSwitchRow')
    const recordingSwitch = () => tree!.root.findAllByType(SettingsSwitchRow).find(node => node.props.title === '保存续播进度')!
    assert.equal(recordingSwitch().props.checked, true, 'missing preference defaults to enabled resume')
    assert.equal(writes, 0, 'player preference is a draft until saved')
    await act(async () => { tree!.root.findAllByType('button').find(node => textOf(node) === '保存')!.props.onClick() })
    assert.equal(writes, 1)
    assert.deepEqual(patches, [{ playerPath: 'D:\\播放器\\Player.exe', playerPreference: 'builtin', resumePlayback: true }])
    assert.equal(tree!.root.findByProps({ placeholder: 'https://192.168.1.10:8096' }).props.value, 'http://new-server:8096')
    assert.match(textOf(tree!.root), /待保存/)
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

it('keeps the full pairing error available through the feedback details action', async () => {
  const previousWindow = globalThis.window
  const { api } = await import('../../api')
  const previousComputer = api.thisComputer
  const previousUpdate = api.serverUpdate
  const detail = '配对失败：' + '很长的技术详情和恢复建议。'.repeat(30)
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: {
      thisComputer: { get: async () => ({ mode: 'local', remoteBaseUrl: null, playerPath: null }) },
      serverUpdate: { control: async (command: { action: string }) => {
        if (command.action === 'connectionStatus') return { connection: null }
        throw new Error(detail)
      } }
    }
  } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  let router: ReturnType<typeof createMemoryRouter> | undefined
  try {
    api.thisComputer = window.api.thisComputer
    api.serverUpdate = window.api.serverUpdate
    const { default: Panel } = await import('./CatalogConnectionPanel')
    const { default: TextArea } = await import('../TextArea')
    const { default: Feedback } = await import('./SettingsFeedback')
    router = createMemoryRouter([{ path: '*', element: <DesktopSessionContext.Provider value={{
      session: { ...EMPTY_DESKTOP_SESSION, mode: 'local', state: 'available' }, capabilities: {} as never, catalogReadsEnabled: true,
      reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
    }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider> }])
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router!} />) })
    act(() => tree!.root.findAllByType('button').find(button => button.props.role === 'radio' && button.props['aria-label'] === '远程资料库')!.props.onClick())
    act(() => tree!.root.findAllByType('input').find(node => node.props.placeholder === 'https://192.168.1.10:8096')!.props.onChange({ target: { value: 'https://example.test' } }))
    act(() => tree!.root.findByType(TextArea).props.onChange({ target: { value: 'a'.repeat(64) } }))
    await act(async () => { tree!.root.findByProps({ 'aria-label': '写入授权', 'aria-busy': false }).props.onSubmit({ preventDefault() {} }) })
    const feedback = tree!.root.findAllByType(Feedback).find(node => node.props.error)!
    assert.equal(feedback.props.detail, detail)
    assert.ok(feedback.props.message.length < 40, 'the compact line remains a summary')
    assert.ok(feedback.findAllByType('button').some(button => textOf(button) === '查看详情' && !button.props.disabled && button.props.tabIndex !== -1))
  } finally {
    act(() => tree?.unmount()); router?.dispose()
    api.thisComputer = previousComputer; api.serverUpdate = previousUpdate
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

it('shows built-in playback as the default and saves an external selection only after confirmation', async () => {
  const previousWindow = globalThis.window
  let settings: ThisComputerSettings = {
    mode: 'local', remoteBaseUrl: null, closeToTray: false, theme: 'graphite',
    playerPath: '/Applications/Player.app', playerPreference: 'builtin',
    playbackVolume: 50, resumePlayback: false,
    proxyUrl: '', proxyUrlEnabled: false, llmProxyUrl: '', llmProxyUrlEnabled: false
  }
  let resolveSettings: (settings: ThisComputerSettings) => void = () => {}
  const loading = new Promise<ThisComputerSettings>(resolve => { resolveSettings = resolve })
  const patches: ThisComputerSettingsPatch[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: { thisComputer: {
      get: async () => loading,
      update: async (patch: ThisComputerSettingsPatch) => {
        patches.push(patch)
        settings = { ...settings, ...patch }
        return { settings, restartRequired: false }
      }
    } }
  } })
  let tree: TestRenderer.ReactTestRenderer | undefined
  let router: ReturnType<typeof createMemoryRouter> | undefined
  try {
    const { default: Panel } = await import('./CatalogConnectionPanel')
    const { api } = await import('../../api')
    const { default: SettingsFormActions } = await import('./SettingsFormActions')
    const { SettingsCard } = await import('./SettingsPrimitives')
    const { default: SettingsSwitchRow } = await import('../SettingsSwitchRow')
    api.thisComputer = window.api.thisComputer
    router = createMemoryRouter([{ path: '*', element: <DesktopSessionContext.Provider value={{
      session: { ...EMPTY_DESKTOP_SESSION, state: 'available', mode: 'local' },
      capabilities: {} as never, catalogReadsEnabled: true,
      reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
    }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider> }])
    await act(async () => { tree = TestRenderer.create(<RouterProvider router={router!} />) })
    const preference = (label = '内置播放器') => tree!.root.findAllByType('button').find(node => node.props['aria-pressed'] !== undefined && textOf(node) === label)!
    assert.equal(preference().props['aria-pressed'], true)
    assert.equal(preference().props.disabled, true, 'loading settings cannot overwrite a saved preference')
    assert.equal(tree!.root.findAllByType(SettingsFormActions).length, 2)
    for (const title of ['资料库配置', '播放器']) {
      const card = tree!.root.findAllByType(SettingsCard).find(node => node.props.title === title)!
      assert.equal(card.props.actions.type, SettingsFormActions)
      assert.equal(card.props.actions.props.placement, 'header')
    }
    const recordingSwitch = () => tree!.root.findAllByType(SettingsSwitchRow).find(node => node.props.title === '保存续播进度')!
    assert.equal(recordingSwitch().props.checked, true)
    await act(async () => { resolveSettings(settings) })
    assert.equal(preference().props['aria-pressed'], true)
    assert.equal(preference().props.disabled, false)
    assert.equal(recordingSwitch().props.checked, false, 'an explicit saved choice overrides defaults')
    assert.equal(recordingSwitch().props.disabled, false)
    assert.equal(textOf(preference()), '内置播放器')
    assert.match(textOf(tree!.root), /内置播放支持本机与远程媒体库的影片文件/)
    const playerCard = tree!.root.findAllByType('section').find(node => node.props['aria-label'] === '播放器')!
    assert.equal(playerCard.findAllByType('details').length, 0, 'program configuration stays visible in built-in mode')
    assert.equal(playerCard.findByProps({ placeholder: '选择程序或输入绝对路径' }).props.value, '/Applications/Player.app')
    assert.equal(patches.length, 0, 'loading the default does not save settings')
    act(() => preference('外部播放器').props.onClick())
    assert.equal(settings.playerPreference, 'builtin', 'selecting external is still a draft')
    assert.equal(patches.length, 0)
    assert.equal(recordingSwitch().props.disabled, true)
    assert.match(recordingSwitch().props.description, /外部播放器自行管理续播进度/)
    const saveButton = () => tree!.root.findAllByType('button').find(node => textOf(node) === '保存')!
    const pathInput = () => tree!.root.findByProps({ placeholder: '选择程序或输入绝对路径' })
    assert.equal(pathInput().props['aria-required'], true)
    for (const path of ['', '   ']) {
      act(() => pathInput().props.onChange({ target: { value: path } }))
      assert.equal(saveButton().props.disabled, true)
      const playerActions = tree!.root.findAllByType(SettingsFormActions)[1]
      assert.equal(playerActions.findAllByType('button').find(node => node.props['aria-label'] === '取消更改')!.props.disabled, false)
      // The leave guard uses the same save handler even when the header is disabled.
      await act(async () => { playerActions.props.onSave() })
      assert.equal(patches.length, 0)
    }
    act(() => pathInput().props.onChange({ target: { value: ' /Applications/Player.app ' } }))
    assert.equal(saveButton().props.disabled, false)
    await act(async () => { tree!.root.findAllByType('button').find(node => textOf(node) === '保存')!.props.onClick() })
    assert.deepEqual(patches, [{ playerPath: '/Applications/Player.app', playerPreference: 'external', resumePlayback: false }])
    assert.equal(preference('外部播放器').props['aria-pressed'], true)
    assert.equal(preference().props['aria-pressed'], false)
    assert.equal(settings.playerPath, '/Applications/Player.app')
    assert.doesNotMatch(textOf(tree!.root), /待保存/)
    act(() => preference().props.onClick())
    assert.equal(recordingSwitch().props.disabled, false)
    assert.equal(recordingSwitch().props.checked, false, 'switching playback mode retains the resume preference')
  } finally {
    act(() => tree?.unmount())
    router?.dispose()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

it('shows actual versions in the read-only status card, including mismatched and unknown servers', async () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener() {}, removeEventListener() {}, api: { thisComputer: {
      get: async () => ({ mode: 'remote', remoteBaseUrl: 'http://localhost:8096', playerPath: null })
    } }
  } })
  try {
    const { default: Panel } = await import('./CatalogConnectionPanel')
    const { api } = await import('../../api')
    api.thisComputer = window.api.thisComputer
    for (const mode of ['mismatch', 'unknown', 'local'] as const) {
      const session: DesktopSession = {
        ...EMPTY_DESKTOP_SESSION, mode: mode === 'local' ? 'local' : 'remote',
        state: mode === 'mismatch' ? 'versionMismatch' : mode === 'unknown' ? 'disconnected' : 'available',
        desktopAppVersion: '0.8.0-beta.1',
        appVersion: mode === 'unknown' ? null : mode === 'local' ? '0.8.0-beta.1' : '0.8.0-beta.3'
      }
      const router = createMemoryRouter([{ path: '*', element: <DesktopSessionContext.Provider value={{
        session, capabilities: {} as never, catalogReadsEnabled: false,
        reconnect: async () => {}, claimWriter: async () => { throw new Error('unused') }
      }}><SettingsLeaveGuard><Panel /></SettingsLeaveGuard></DesktopSessionContext.Provider> }])
      let tree: TestRenderer.ReactTestRenderer | undefined
      try {
        await act(async () => { tree = TestRenderer.create(<RouterProvider router={router} />) })
        const status = tree!.root.findAllByType('section').find(node => node.props['aria-label'] === '当前连接')!
        assert.equal(status.findAll(node => typeof node.type === 'string' && ['button', 'a', 'input', 'textarea', 'select', 'summary'].includes(node.type)).length, 0, 'status is display-only')
        const details = status.findByProps({ 'aria-label': '应用版本' })
        const values = Object.fromEntries(details.findAllByType('dt').map(label =>
          [textOf(label), textOf(label.parent!.findByType('dd'))]))
        assert.equal(values['本地版本'], '0.8.0-beta.1')
        assert.equal(values['服务端版本'], mode === 'local' ? undefined : mode === 'unknown' ? '未获取' : '0.8.0-beta.3')
      } finally {
        act(() => tree?.unmount())
        router.dispose()
      }
    }
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

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
    const session: DesktopSession = {
      state: 'available', mode: 'remote', catalogId: 'catalog', serverId: 'server',
      remoteBaseUrl: serverUrl,
      generation: 1, writerEpoch: 1, frozen: false, appVersion: 'test',
      schemaVersion: 1, message: null
    }
    const activeRouter = createMemoryRouter([{ path: '*', element: (
      <DesktopSessionContext.Provider value={{
        session, capabilities: {} as never,
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
    const modeChoice = (mode: 'local' | 'remote') => renderer!.root.findAllByType('button').find(node => node.props.role === 'radio' && node.props['aria-label'] === (mode === 'local' ? '本地资料库' : '远程资料库'))!
    act(() => modeChoice('local').props.onClick())
    assert.match(textOf(renderer!.root), /待保存/)
    const save = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '应用配置')!
    await act(async () => { save.props.onClick() })
    assert.deepEqual(writes, [{ mode: 'local', remoteBaseUrl: serverUrl }])
    assert.equal(persisted.mode, 'local')
    assert.match(textOf(renderer!.root), /已保存 · 重启后生效/)
    assert.match(textOf(renderer!.root), /当前使用：远程资料库.*重启后使用：本地资料库/)
    assert.doesNotMatch(textOf(renderer!.root), /待保存/)
    await act(async () => { await router!.navigate('/next') })
    assert.equal(router.state.location.pathname, '/next')
    await act(async () => { await router!.navigate('/settings') })
    assert.equal(modeChoice('local').props['aria-checked'], true)
    assert.ok(renderer!.root.findAllByType('div').some(node => node.props.role === 'group' && node.props['aria-label'] === '默认播放方式'), 'local mode also exposes player preferences')
    assert.match(textOf(renderer!.root), /当前使用：远程资料库.*重启后使用：本地资料库/)
    act(() => modeChoice('remote').props.onClick())
    assert.equal(renderer!.root.findByProps({ placeholder: 'https://192.168.1.10:8096' }).props.value, serverUrl)
    const probe = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '测试连接')!
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

    assert.match(textOf(renderer!.root), /待保存/)
    assert.equal(renderer!.root.findAllByType('button').find((button) => textOf(button) === '立即重启')!.props.disabled, true)
    act(() => modeChoice('local').props.onClick())
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
