import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
window.api = {}
window.fixtureProviderWrites = 0
applyTheme(new URLSearchParams(location.search).get('theme') || 'slate')
const { default: ModelProvidersPanel } = await import('../../apps/desktop/src/renderer/src/components/settings/ModelProvidersPanel')
const connections = [
  { id: 'builtin:openai', providerId: 'openai', name: 'OpenAI', status: 'ready', modelCount: 1 },
  { id: 'builtin:gemini', providerId: 'gemini', name: 'Gemini', status: 'unconfigured', modelCount: 0 },
  { id: 'builtin:deepseek', providerId: 'deepseek', name: 'DeepSeek', status: 'unconfigured', modelCount: 0 }
].map(connection => ({ source: 'builtin', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1',
  local: false, enabled: true, agentCompatible: true, credentialRef: connection.id, ...connection }))
function Fixture() {
  const [revision, setRevision] = useState(1)
  window.refreshProviderFixture = () => setRevision(value => value + 1)
  const snapshot = { schemaVersion: 4, revision: String(revision), updatedAt: '2026-01-01T00:00:00Z',
    connections, models: [], assignments: [], validationErrors: [] }
  return <ModelProvidersPanel snapshot={snapshot} busy={false} apply={async () => {
    window.fixtureProviderWrites++
    return true
  }} />
}
createRoot(document.getElementById('root')).render(<MemoryRouter><Fixture /></MemoryRouter>)
