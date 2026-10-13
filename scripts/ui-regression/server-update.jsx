import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { DesktopSessionContext } from '../../apps/desktop/src/renderer/src/desktop/DesktopSessionContext'
import { SETTINGS_GROUPS } from '../../apps/desktop/src/renderer/src/settings/settingsRoutes'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.updateCalls = []
window.updateReconnects = 0
window.failUpdateReconnects = 0
let state = { protocolVersion: 1, paired: true, serverId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', currentVersion: '0.8.0', platform: 'linux/amd64', runtime: 'node22-bookworm-v1', targetVersion: null, job: null }
state.paired = new URLSearchParams(location.search).get('unpaired') !== '1'
window.api = { serverUpdate: { control: async command => {
  window.updateCalls.push(command.action)
  if (command.action === 'pair') state.paired = true
  if (command.action === 'check') {
    if (window.failUpdateCheck) throw new Error('更新清单下载失败，请检查服务端网络和发布签名配置；这里是一段较长中文错误，用于验证反馈截断、详情与布局稳定。')
    state.targetVersion = '0.8.1'
  }
  if (command.action === 'prepare') state.job = { id: '33333333-3333-4333-8333-333333333333', version: '0.8.1', phase: 'prepared', receivedBytes: 0, totalBytes: 100 * 1024 ** 2, updatedAt: new Date().toISOString(), message: null }
  if (command.action === 'install') state.job.phase = 'verifying'
  return structuredClone(state)
} } }
window.finishServerUpdate = () => { state.currentVersion = '0.8.1'; state.targetVersion = null; state.job.phase = 'complete' }
window.setUpdateTheme = applyTheme
applyTheme('graphite')
const [{ default: Panel }, { default: Shell }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/settings/ServerUpdatePanel'),
  import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell')
])
function App() {
  const [session, setSession] = React.useState({ state: 'versionMismatch', mode: 'remote', serverId: state.serverId, catalogId: state.catalogId, desktopAppVersion: '0.8.1', appVersion: '0.8.0', schemaVersion: 19, generation: 1, frozen: false, writerEpoch: 1 })
  const reconnect = React.useCallback(async () => {
    window.updateReconnects++
    if (window.failUpdateReconnects > 0) {
      window.failUpdateReconnects--
      setSession(previous => ({ ...previous, state: 'disconnected' }))
      return
    }
    setSession(previous => ({ ...previous, state: 'available', appVersion: state.currentVersion, schemaVersion: 20 }))
  }, [])
  window.updateSession = session
  return <MemoryRouter><OverlayHistoryProvider>
  <DesktopSessionContext.Provider value={{ session, capabilities: {}, catalogReadsEnabled: session.state === 'available', reconnect, claimWriter: async () => {} }}>
    <div style={{ display: 'flex', height: '100vh', minWidth: 0 }}>
      <main style={{ display: 'flex', flex: 1, minWidth: 0 }}>
        <Shell activeGroup={SETTINGS_GROUPS.find(group => group.id === 'storage')} activeTab="connection" onNavigate={() => {}} onTabKeyDown={() => {}}><Panel /></Shell>
      </main>
    </div>
  </DesktopSessionContext.Provider>
</OverlayHistoryProvider></MemoryRouter>
}
createRoot(document.getElementById('root')).render(<App />)
