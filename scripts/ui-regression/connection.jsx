import React from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { NavigationGuardProvider } from '../../apps/desktop/src/renderer/src/interaction/NavigationGuard'
import LeaveGuard from '../../apps/desktop/src/renderer/src/settings/SettingsLeaveGuard'
import { DesktopSessionContext } from '../../apps/desktop/src/renderer/src/desktop/DesktopSessionContext'
import { SETTINGS_GROUPS } from '../../apps/desktop/src/renderer/src/settings/settingsRoutes'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.connectionForgets = 0
const connection = { remoteBaseUrl: 'https://example.test:8096', serverId: 'fixture-server', catalogId: 'fixture-catalog' }
let paired = true
let settings = { mode: 'remote', remoteBaseUrl: connection.remoteBaseUrl, playerPath: '', playerPreference: 'builtin', resumePlayback: true }
const snapshot = () => ({ protocolVersion: 1, paired, connection: paired ? connection : null, devices: [],
  ...connection, currentVersion: '0.9.0-beta.5', targetVersion: null, platform: 'linux/amd64', job: null })
window.api = {
  thisComputer: { get: async () => settings, update: async patch => ({ settings: settings = { ...settings, ...patch }, restartRequired: false }),
    probe: async () => new Promise(resolve => { window.finishConnectionProbe = () => resolve({ status: 'reachable', message: '完整连接诊断：' + '较长中文信息'.repeat(80), serverVersion: '0.9.0-beta.5', ...connection }) }),
    pickPlayer: async () => null, detectPlayer: async () => ({ status: 'unavailable', message: 'synthetic fixture' }), restart: async () => {} },
  serverUpdate: { control: async command => {
    if (command.action === 'forgetConnection') { paired = false; window.connectionForgets++ }
    return snapshot()
  } }
}
window.setConnectionTheme = applyTheme
applyTheme('light')
const [{ default: Panel }, { default: Shell }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/settings/CatalogConnectionPanel'),
  import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell')
])
const session = { state: 'available', mode: 'remote', ...connection, appVersion: '0.9.0-beta.5', desktopAppVersion: '0.9.0-beta.5', generation: 1, schemaVersion: 21, frozen: false, writerEpoch: 1 }
const router = createMemoryRouter([{ path: '*', element: <OverlayHistoryProvider><NavigationGuardProvider><LeaveGuard>
  <DesktopSessionContext.Provider value={{ session, capabilities: {}, catalogReadsEnabled: true, reconnect: async () => {}, claimWriter: async () => {} }}>
    <div style={{ display: 'flex', height: '100vh', minWidth: 0 }}><main style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      <Shell activeGroup={SETTINGS_GROUPS.find(group => group.id === 'storage')} activeTab="mode" onNavigate={() => {}} onTabKeyDown={() => {}}><Panel /></Shell>
    </main></div>
  </DesktopSessionContext.Provider>
</LeaveGuard></NavigationGuardProvider></OverlayHistoryProvider> }])
createRoot(document.getElementById('root')).render(<RouterProvider router={router} />)
