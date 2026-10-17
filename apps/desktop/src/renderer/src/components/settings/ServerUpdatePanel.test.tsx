import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { EMPTY_DESKTOP_SESSION, type DesktopSession } from '@shared/desktop/session'
import type { ServerEnvironmentSnapshot } from '@shared/serverEnvironment'
import type { ServerUpdateCommand, ServerUpdateSnapshot } from '@shared/serverUpdateTypes'
import { DesktopSessionContext } from '../../desktop/DesktopSessionContext'
import { renderedText } from '../../test/renderedText'

const compatible: ServerEnvironmentSnapshot = { state: 'compatible', currentVersion: 1, requiredVersion: 1, runtimeId: 'node22-bookworm-v1', platform: 'linux/amd64', message: null }
const initial: ServerUpdateSnapshot = { protocolVersion: 1, paired: true, serverId: 's', catalogId: 'c', currentVersion: '0.8.0', platform: 'linux/amd64', targetVersion: '0.9.0-beta.1', job: null, environment: compatible }
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
    const commands = calls.filter(item => item.action !== 'status' && item.action !== 'environment')
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

for (const interrupted of [false, true]) test(`an older completed job cannot block a new upgrade and interrupted uploads can resume (${interrupted})`, async () => {
  const previousWindow = globalThis.window
  const current = { ...initial, job: { id: 'old-job', version: interrupted ? session.desktopAppVersion : initial.currentVersion!,
    phase: interrupted ? 'preparing' as const : 'complete' as const, receivedBytes: 7, totalBytes: 10,
    updatedAt: new Date().toISOString(), message: null, resumableUpload: interrupted } }
  const calls: ServerUpdateCommand[] = []
  const control = async (command: ServerUpdateCommand): Promise<ServerUpdateSnapshot> => {
    calls.push(command)
    return command.action === 'import' ? { ...current, job: { ...current.job, version: session.desktopAppVersion, phase: 'prepared', receivedBytes: 10, resumableUpload: false } } : current
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control } } } })
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  let tree: TestRenderer.ReactTestRenderer | undefined
  let reconnects = 0
  try {
    api.serverUpdate = window.api.serverUpdate
    const [{ default: Panel }, { default: Button }] = await Promise.all([import('./ServerUpdatePanel'), import('../Button')])
    await act(async () => { tree = TestRenderer.create(<DesktopSessionContext.Provider value={{ session, capabilities: {} as never, catalogReadsEnabled: false, reconnect: async () => { reconnects++ }, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>) })
    assert.equal(reconnects, 0)
    const upload = tree!.root.findAllByType(Button).find(node => renderedText(node) === '上传离线包升级')
    assert.ok(upload, 'the matching offline file can be selected again')
    assert.equal(upload.props.disabled, false)
    if (!interrupted) assert.ok(tree!.root.findAllByType(Button).some(node => renderedText(node) === '在线升级'))
    await act(async () => { upload.props.onClick() })
    assert.deepEqual(calls.filter(command => command.action !== 'status' && command.action !== 'environment'), [{ action: 'import', targetVersion: session.desktopAppVersion }])
    assert.ok(tree!.root.findAllByType(Button).some(node => renderedText(node) === '确认升级'))
  } finally {
    act(() => tree?.unmount())
    api.serverUpdate = previousApi
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

async function mountPanel(control: (command: ServerUpdateCommand) => Promise<ServerUpdateSnapshot>, currentSession: DesktopSession = session, reconnect = async () => {}) {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: { serverUpdate: { control } } } })
  const { api } = await import('../../api')
  const previousApi = api.serverUpdate
  api.serverUpdate = window.api.serverUpdate
  const [{ default: Panel }, { default: Button }] = await Promise.all([import('./ServerUpdatePanel'), import('../Button')])
  const provider = (value: DesktopSession) => <DesktopSessionContext.Provider value={{ session: value, capabilities: {} as never, catalogReadsEnabled: false, reconnect, claimWriter: async () => { throw new Error('unused') } }}><Panel /></DesktopSessionContext.Provider>
  let tree: TestRenderer.ReactTestRenderer
  await act(async () => { tree = TestRenderer.create(provider(currentSession)) })
  return {
    get tree() { return tree! },
    button: (label: string) => tree!.root.findAllByType(Button).find(node => renderedText(node) === label)!,
    updateSession: async (value: DesktopSession) => { await act(async () => { tree!.update(provider(value)) }) },
    dispose: () => {
      act(() => tree!.unmount())
      api.serverUpdate = previousApi
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
    }
  }
}

test('an older image disables both upgrade entries and offers the selected inline image guide', async () => {
  const calls: ServerUpdateCommand[] = []
  const environment: ServerEnvironmentSnapshot = { ...compatible, state: 'imageRequired', currentVersion: 1, requiredVersion: 2, message: '需要升级服务端Docker镜像' }
  const panel = await mountPanel(async command => {
    calls.push(command)
    return command.action === 'environment' ? { ...initial, environment } : initial
  })
  try {
    assert.match(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.ok(panel.button('查看镜像升级指引'))
    assert.ok(panel.button('重新检测'))
    assert.match(renderedText(panel.tree.root), /当前环境.*运行环境版本 1.*本版要求.*运行环境版本 2/)
    assert.doesNotMatch(renderedText(panel.tree.root), /最低要求|及以上/)
    assert.ok(calls.some(command => command.action === 'environment'))
    assert.ok(calls.every(command => command.action === 'environment' || command.action === 'status'))
  } finally { panel.dispose() }
})

test('an old HTTP deployment offers the image upgrade and retries migration only on explicit recheck', async () => {
  let reconnects = 0
  const environment: ServerEnvironmentSnapshot = { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' }
  const panel = await mountPanel(async () => ({ ...initial, paired: false, environment }),
    { ...session, appVersion: '0.8.0', legacyHttpUpgradeRequired: true }, async () => { reconnects++ })
  try {
    assert.equal(reconnects, 0)
    assert.match(renderedText(panel.tree.root), /服务端仍为 0.8.0.*升级服务端 Docker 镜像.*保留原授权/)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.ok(panel.button('查看镜像升级指引'))
    await act(async () => { panel.button('重新检测').props.onClick() })
    assert.equal(reconnects, 1)
  } finally { panel.dispose() }
})

test('an unavailable environment keeps connection details through retry without claiming an image upgrade is required', async () => {
  let queries = 0
  let finish: (value: ServerUpdateSnapshot) => void = () => {}
  const pending = new Promise<ServerUpdateSnapshot>(resolve => { finish = resolve })
  const panel = await mountPanel(async command => {
    if (command.action !== 'environment') return initial
    if (++queries === 1) throw new Error('证书校验失败，请检查连接配置')
    return pending
  })
  try {
    const { default: Feedback } = await import('./SettingsFeedback')
    assert.match(renderedText(panel.tree.root), /无法确认服务端运行环境/)
    assert.doesNotMatch(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.equal(panel.tree.root.findByType(Feedback).props.detail, '证书校验失败，请检查连接配置')
    await act(async () => { panel.button('重新检测').props.onClick() })
    assert.equal(panel.button('重新检测').props.busy, true)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.tree.root.findByType(Feedback).props.detail, '证书校验失败，请检查连接配置')
    await act(async () => { finish(initial); await pending })
    assert.equal(panel.button('重新检测').props.busy, false)
    assert.equal(panel.button('在线升级').props.disabled, false)
    assert.equal(panel.button('上传离线包升级').props.disabled, false)
    assert.doesNotMatch(renderedText(panel.tree.root), /证书校验失败/)
  } finally { panel.dispose() }
})

test('switching service origin and identity cancels old command ownership before the new target is used', async () => {
  let finishOld: (value: ServerUpdateSnapshot) => void = () => {}
  const oldCheck = new Promise<ServerUpdateSnapshot>(resolve => { finishOld = resolve })
  let current = initial
  const calls: Array<{ serverId: string | null; command: ServerUpdateCommand }> = []
  const panel = await mountPanel(async command => {
    calls.push({ serverId: current.serverId, command })
    if (command.action === 'check') return oldCheck
    return current
  }, { ...session, remoteBaseUrl: 'https://old.example' })
  try {
    await act(async () => { panel.button('在线升级').props.onClick() })
    current = { ...initial, serverId: 'new-server', catalogId: 'new-catalog' }
    await panel.updateSession({ ...session, remoteBaseUrl: 'https://new.example', serverId: 'new-server', catalogId: 'new-catalog' })
    assert.equal(panel.button('上传离线包升级').props.disabled, false)
    await act(async () => { panel.button('上传离线包升级').props.onClick() })
    assert.ok(calls.some(call => call.serverId === 'new-server' && call.command.action === 'import'))
    await act(async () => { finishOld(initial); await oldCheck })
    assert.doesNotMatch(renderedText(panel.tree.root), /已有升级请求|不属于当前资料库/)
    assert.equal(calls.some(call => call.command.action === 'prepare'), false, 'the old check cannot prepare against the new target')
  } finally {
    finishOld(initial)
    panel.dispose()
  }
})

test('environment detection is independent of status and still exposes the gate for the same business version', async () => {
  const sameVersion = { ...session, state: 'available' as const, appVersion: session.desktopAppVersion }
  let finish: (value: ServerUpdateSnapshot) => void = () => {}
  const pending = new Promise<ServerUpdateSnapshot>(resolve => { finish = resolve })
  const calls: ServerUpdateCommand[] = []
  const panel = await mountPanel(async command => {
    calls.push(command)
    if (command.action === 'environment') return pending
    throw new Error('旧镜像未提供升级状态接口')
  }, sameVersion)
  try {
    assert.ok(calls.some(command => command.action === 'environment'))
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.equal(panel.button('重新检测').props.busy, true)
    assert.equal(panel.button('查看镜像升级指引').props.variant, 'ghost')
    assert.ok(panel.tree.root.findAllByProps({ role: 'status' }).some(node => node.props['aria-busy'] === true))
    await act(async () => {
      finish({ ...initial, paired: false, currentVersion: session.desktopAppVersion, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' } })
      await pending
    })
    assert.match(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
  } finally {
    finish(initial)
    panel.dispose()
  }
})

for (const environment of [
  { ...compatible, state: 'clientRequired' as const, currentVersion: 2, message: '服务端运行环境较新，请升级此客户端' },
  { ...compatible, currentVersion: 2 },
  { ...compatible, state: 'unavailable' as const, message: '未知的运行环境格式' }
]) test(`only an exactly matching environment opens upgrade actions (${environment.state}/${environment.currentVersion})`, async () => {
  const panel = await mountPanel(async command => command.action === 'environment' ? { ...initial, environment } : initial)
  try {
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.doesNotMatch(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    if (environment.state === 'clientRequired') assert.match(renderedText(panel.tree.root), /请升级此客户端/)
  } finally { panel.dispose() }
})

test('equal environment does not replace the existing pairing prerequisite', async () => {
  const panel = await mountPanel(async () => ({ ...initial, paired: false }))
  try {
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.match(renderedText(panel.tree.root), /请先在资料库连接中连接此服务端/)
  } finally { panel.dispose() }
})

for (const phase of ['verifying', 'recoveryRequired'] as const) test(`an environment failure cannot replace the existing ${phase} job`, async () => {
  const current: ServerUpdateSnapshot = { ...initial, job: { id: 'active-job', version: session.desktopAppVersion, phase, receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: phase === 'recoveryRequired' ? '请按人工恢复指引处理，保留原卷' : null } }
  const calls: ServerUpdateCommand[] = []
  const panel = await mountPanel(async command => {
    calls.push(command)
    if (command.action === 'environment') throw new Error('服务端正在维护')
    return current
  })
  try {
    assert.match(renderedText(panel.tree.root), phase === 'verifying' ? /正在验证服务/ : /需要人工恢复/)
    if (phase === 'verifying') assert.ok(panel.tree.root.findByProps({ 'aria-label': '升级进度' }))
    else assert.match(renderedText(panel.tree.root), /请按人工恢复指引处理，保留原卷/)
    assert.equal(panel.button('在线升级'), undefined)
    assert.equal(panel.button('确认升级'), undefined)
    assert.ok(calls.every(command => command.action === 'status' || command.action === 'environment'))
  } finally { panel.dispose() }
})

test('a prepared bundle is not an exception to the environment gate', async () => {
  const prepared: ServerUpdateSnapshot = { ...initial, job: { id: 'prepared-job', version: session.desktopAppVersion, phase: 'prepared', receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: null } }
  const panel = await mountPanel(async command => command.action === 'environment' ? { ...prepared, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' } } : prepared)
  try {
    assert.equal(panel.button('确认升级'), undefined)
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
  } finally { panel.dispose() }
})

test('a confirmed missing environment endpoint leads with image replacement instead of a legacy pairing error', async () => {
  const panel = await mountPanel(async command => {
    if (command.action === 'status') throw new Error('旧管理器授权错误，请先配对')
    return { ...initial, paired: false, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' } }
  })
  try {
    const { default: Feedback } = await import('./SettingsFeedback')
    const feedback = panel.tree.root.findByType(Feedback)
    assert.match(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    assert.equal(feedback.props.message, '业务升级无法更新镜像内的运行环境。请先升级服务端 Docker 镜像，再点击“重新检测”。')
    assert.doesNotMatch(feedback.props.message, /配对|授权/)
    assert.match(feedback.props.detail, /旧管理器授权错误/)
    assert.equal(panel.button('查看镜像升级指引').props.variant, 'primary')
  } finally { panel.dispose() }
})

for (const state of ['unavailable', 'clientRequired'] as const) test(`${state} does not make the Docker guide the primary action`, async () => {
  const panel = await mountPanel(async () => ({ ...initial, environment: { ...compatible, state, currentVersion: state === 'clientRequired' ? 2 : null, message: state === 'unavailable' ? '连接超时' : '服务端运行环境较新，请升级此客户端' } }))
  try {
    assert.equal(panel.button('查看镜像升级指引').props.variant, 'ghost')
    if (state === 'unavailable') assert.equal(panel.button('重新检测').props.variant, 'primary')
    else assert.match(renderedText(panel.tree.root), /请升级此客户端/)
  } finally { panel.dispose() }
})

test('a running install keeps its progress rather than prompting image replacement', async () => {
  const panel = await mountPanel(async () => ({ ...initial, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' }, job: { id: 'running', version: session.desktopAppVersion, phase: 'installing', receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: null } }))
  try {
    assert.ok(panel.tree.root.findByProps({ 'aria-label': '升级进度' }))
    assert.match(renderedText(panel.tree.root), /正在安装版本/)
    assert.notEqual(panel.button('查看镜像升级指引')?.props.variant, 'primary')
    const { default: Feedback } = await import('./SettingsFeedback')
    assert.doesNotMatch(panel.tree.root.findByType(Feedback).props.message, /升级服务端Docker镜像/)
  } finally { panel.dispose() }
})

test('rechecking a prepared bundle retains the ready controls and disables installation in place', async () => {
  const prepared: ServerUpdateSnapshot = { ...initial, job: { id: 'prepared-job', version: session.desktopAppVersion, phase: 'prepared', receivedBytes: 10, totalBytes: 10, updatedAt: new Date().toISOString(), message: null } }
  let queries = 0
  let finish: (value: ServerUpdateSnapshot) => void = () => {}
  const pending = new Promise<ServerUpdateSnapshot>(resolve => { finish = resolve })
  const panel = await mountPanel(async command => command.action === 'environment' && ++queries > 1 ? pending : prepared)
  try {
    assert.equal(panel.button('确认升级').props.disabled, false)
    await act(async () => { panel.button('重新检测').props.onClick() })
    assert.ok(panel.button('确认升级'), 'rechecking keeps the prepared controls mounted')
    assert.equal(panel.button('确认升级').props.disabled, true)
    assert.equal(panel.button('重新上传').props.disabled, true)
    assert.equal(panel.button('重新检测').props.busy, true)
    await act(async () => { finish(prepared); await pending })
    assert.equal(panel.button('确认升级').props.disabled, false)
  } finally {
    finish(prepared)
    panel.dispose()
  }
})

test('a late environment response from the previous origin cannot open the new origin upgrade entries', async () => {
  let queries = 0
  let finish: (value: ServerUpdateSnapshot) => void = () => {}
  const oldEnvironment = new Promise<ServerUpdateSnapshot>(resolve => { finish = resolve })
  const panel = await mountPanel(async command => {
    if (command.action !== 'environment') return initial
    if (++queries === 1) return oldEnvironment
    return { ...initial, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' } }
  }, { ...session, remoteBaseUrl: 'https://old.example' })
  try {
    await panel.updateSession({ ...session, remoteBaseUrl: 'https://next.example' })
    assert.match(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
    await act(async () => { finish(initial); await oldEnvironment })
    assert.equal(panel.button('在线升级').props.disabled, true)
    assert.equal(panel.button('上传离线包升级').props.disabled, true)
    assert.match(renderedText(panel.tree.root), /需要升级服务端Docker镜像/)
  } finally {
    finish(initial)
    panel.dispose()
  }
})

test('the image guide explains preserved volumes and opens official deployment documentation through the desktop API', async () => {
  const panel = await mountPanel(async () => ({ ...initial, environment: { ...compatible, state: 'imageRequired', currentVersion: null, message: '需要升级服务端Docker镜像' } }))
  const { api } = await import('../../api')
  const previousExternal = api.externalLinks
  const opened: string[] = []
  api.externalLinks = { open: async url => { opened.push(url); return true } }
  try {
    const { default: Modal } = await import('../Modal')
    await act(async () => { panel.button('查看镜像升级指引').props.onClick() })
    const guide = panel.tree.root.findByType(Modal)
    assert.match(renderedText(guide), /备份重要资料/)
    assert.match(renderedText(guide), /\/data.*\/program.*图片卷/)
    assert.match(renderedText(guide), /重新创建容器.*仅拉取镜像或重启旧容器不会应用新镜像/)
    assert.equal(guide.props.confirmText, '打开官方部署文档')
    await act(async () => { await guide.props.onConfirm() })
    assert.deepEqual(opened, ['https://javdexlabs.github.io/Javdex/server/deploy/'])
    await act(async () => { guide.props.onCancel() })
    assert.equal(panel.tree.root.findAllByType(Modal).length, 0)
  } finally {
    api.externalLinks = previousExternal
    panel.dispose()
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
