import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { DesktopSessionContext } from '../../apps/desktop/src/renderer/src/desktop/DesktopSessionContext'
import { SETTINGS_GROUPS } from '../../apps/desktop/src/renderer/src/settings/settingsRoutes'
import { SERVER_ENVIRONMENT_VERSION } from '../../packages/contracts/src/serverEnvironment'
import product from '../../package.json'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.updateCalls = []
window.updateReconnects = 0
window.failUpdateReconnects = 0
window.openExternalCalls = []
const query = new URLSearchParams(location.search)
const desktopVersion = product.version
const sameVersion = query.get('sameVersion') === '1' || query.get('same') === '1'
let state = { protocolVersion: 1, paired: query.get('unpaired') !== '1', serverId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', currentVersion: sameVersion ? desktopVersion : '0.9.0-beta.4', platform: 'linux/amd64', runtime: 'node22-bookworm-v1', targetVersion: null, job: null }
const makeEnvironment = scenario => {
  const base = { state: 'compatible', currentVersion: SERVER_ENVIRONMENT_VERSION, requiredVersion: SERVER_ENVIRONMENT_VERSION, runtimeId: state.runtime, platform: state.platform, message: null }
  // Preview a future requirement without inventing environment revision 0.
  if (scenario === 'mismatch' || scenario === 'older') return { ...base, state: 'imageRequired', requiredVersion: SERVER_ENVIRONMENT_VERSION + 1, message: '需要升级服务端Docker镜像' }
  if (scenario === 'missing') return { ...base, state: 'imageRequired', currentVersion: null, runtimeId: null, platform: null, message: '需要升级服务端Docker镜像' }
  if (scenario === 'higher') return { ...base, state: 'clientRequired', currentVersion: SERVER_ENVIRONMENT_VERSION + 1, message: '服务端运行环境较新，请升级此客户端' }
  if (scenario === 'unavailable') return { ...base, state: 'unavailable', currentVersion: null, message: '运行环境响应格式无法识别，请检查连接配置后重新检测。' }
  return base
}
let environment = makeEnvironment(query.get('environment'))
window.failUpdateEnvironment = query.get('environment') === 'network'
window.environmentFixture = { actualRequiredVersion: SERVER_ENVIRONMENT_VERSION, lowerRevisionIsMock: query.get('environment') === 'mismatch' || query.get('environment') === 'older' }
window.setUpdateEnvironment = scenario => {
  environment = makeEnvironment(scenario)
  window.failUpdateEnvironment = scenario === 'network'
  window.environmentFixture.lowerRevisionIsMock = scenario === 'mismatch' || scenario === 'older'
}
window.environmentDelay = query.get('environment') === 'checking' ? 5000 : Math.min(10000, Math.max(0, Number(query.get('environmentDelay')) || 0))
const makeJob = (phase = 'prepared') => ({ id: '33333333-3333-4333-8333-333333333333', version: desktopVersion, phase, receivedBytes: 100 * 1024 ** 2, totalBytes: 100 * 1024 ** 2, updatedAt: new Date().toISOString(), message: null })
if (query.has('state')) state.job = makeJob(query.get('state'))
if (query.get('historical') === '1') state.job = { ...makeJob('complete'), version: state.currentVersion }
if (query.get('partial') === '1') state.job = { ...makeJob('preparing'), receivedBytes: 7, resumableUpload: true }
if (query.get('error') === '1') window.failUpdateCheck = true
window.api = { serverUpdate: { control: async command => {
  window.updateCalls.push(command)
  if (command.action === 'environment') {
    if (window.environmentDelay) await new Promise(resolve => setTimeout(resolve, window.environmentDelay))
    if (window.failUpdateEnvironment) throw new Error('运行环境检测连接超时，请核对服务端地址、网络或证书后重新检测；此错误不表示需要升级镜像。')
    return structuredClone({ ...state, environment })
  }
  if (command.action === 'status' && query.get('statusMissing') === '1') throw new Error('旧版镜像未提供升级状态接口')
  if (command.action === 'check') {
    if (window.failUpdateCheck) throw new Error('更新清单下载失败，请检查服务端网络和发布签名配置；这里是一段较长中文错误，用于验证反馈截断、详情与布局稳定。')
    state.targetVersion = desktopVersion
  }
  if (command.action === 'prepare' || command.action === 'import') state.job = makeJob()
  if (command.action === 'install') { state.job.phase = 'verifying' }
  if (command.action === 'install' && query.get('finish') === '1') setTimeout(() => window.finishServerUpdate(), 750)
  return structuredClone(state)
} }, externalLinks: { open: async url => { window.openExternalCalls.push(url); return true } } }
window.finishServerUpdate = () => { state.currentVersion = desktopVersion; state.targetVersion = null; state.job.phase = 'complete' }
window.setUpdateTheme = applyTheme
applyTheme(query.get('theme') || 'graphite')
const [{ default: Panel }, { default: Shell }, { default: Recovery }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/settings/ServerUpdatePanel'),
  import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell'),
  import('../../apps/desktop/src/renderer/src/desktop/DesktopSessionOverlay')
])
function App() {
  const [session, setSession] = React.useState({ state: sameVersion ? 'available' : 'versionMismatch', mode: 'remote', remoteBaseUrl: 'https://javdex.example', serverId: state.serverId, catalogId: state.catalogId, desktopAppVersion: desktopVersion, appVersion: state.currentVersion, schemaVersion: 21, generation: 1, frozen: false, writerEpoch: 1 })
  const reconnect = React.useCallback(async () => {
    window.updateReconnects++
    if (window.failUpdateReconnects > 0) {
      window.failUpdateReconnects--
      setSession(previous => ({ ...previous, state: 'disconnected' }))
      return
    }
    setSession(previous => ({ ...previous, state: 'available', appVersion: state.currentVersion, schemaVersion: 21 }))
  }, [])
  window.updateSession = session
  return <MemoryRouter><OverlayHistoryProvider>
  <DesktopSessionContext.Provider value={{ session, capabilities: {}, catalogReadsEnabled: session.state === 'available', reconnect, claimWriter: async () => {} }}>
    <div style={{ display: 'flex', height: '100vh', minWidth: 0 }}>
      <main style={{ display: 'flex', flex: 1, minWidth: 0, position: 'relative' }}>
        {query.get('recovery') === '1' ? <Recovery /> : <Shell activeGroup={SETTINGS_GROUPS.find(group => group.id === 'storage')} activeTab="mode" onNavigate={() => {}} onTabKeyDown={() => {}}><Panel /></Shell>}
      </main>
    </div>
  </DesktopSessionContext.Provider>
</OverlayHistoryProvider></MemoryRouter>
}
const root = createRoot(document.getElementById('root'))
root.render(<App />)
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount())
