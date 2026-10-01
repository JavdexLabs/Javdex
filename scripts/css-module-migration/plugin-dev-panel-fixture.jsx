import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme')
const settings = params.get('page') === 'pluginDevPanelSettings'
window.api = {
  settings: { getModelManagement: async () => ({
    connections: [], models: [], validationErrors: [],
    assignments: [{ workloadId: 'plugin-developer', resolution: { ready: true, modelName: 'Synthetic Tool Model' } }]
  }) },
  pluginDev: { snapshot: async () => null, onAgentEvent: () => () => {}, discardUnrecoverableSessions: async () => {} },
  scrape: { listPluginDetails: async () => [] },
  actressScrape: { listPluginDetails: async () => [] }
}
const { default: PluginDevPanel } = await import('../../apps/desktop/src/renderer/src/components/pluginDev/PluginDevPanel')
const { SettingsPluginDevShell } = await import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell')
const { ToastProvider } = await import('../../apps/desktop/src/renderer/src/components/Toast')

function Fixture() {
  const route = useLocation()
  const panel = <PluginDevPanel presentation={settings ? 'settings' : 'standalone'}
    loadPackage={null} onInstalled={async () => {}} onLoadConsumed={() => {}} />
  return <>
    <main data-actual-plugin-panel-host style={{ height: 600, display: 'flex', padding: 24, boxSizing: 'border-box',
      containerType: 'inline-size', containerName: 'settings-workspace' }}>
      {settings ? <SettingsPluginDevShell>{panel}</SettingsPluginDevShell> : panel}
    </main>
    <output data-fixture-route>{route.pathname}</output>
  </>
}
createRoot(document.getElementById('root')).render(
  <MemoryRouter initialEntries={['/settings/plugins/developer']}><ToastProvider><Fixture /></ToastProvider></MemoryRouter>
)
