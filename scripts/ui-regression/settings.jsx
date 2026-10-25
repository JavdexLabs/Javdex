import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { OverlayHistoryProvider } from '../../apps/desktop/src/renderer/src/interaction/OverlayHistoryContext'
import { SETTINGS_GROUPS } from '../../apps/desktop/src/renderer/src/settings/settingsRoutes'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import { runtimeComponentsFixture, runtimePlanFixture } from '../../apps/desktop/src/renderer/src/test/localRuntimeFixture'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const family = (id, name, publisher, bytes) => ({ id, name, purpose: id === 'kotoba' ? '日语语音转写' : id === 'qwen3-asr' ? '日语动漫与游戏台词识别（Windows x64）' : '本地文本翻译', version: name,
  bytes, installed: false, inUse: false, selectedVariant: `${id}-q4_k_m`, variants: [{ id: `${id}-q4_k_m`, precision: 'Q4_K_M',
    format: id === 'kotoba' ? 'GGML' : 'GGUF', publisher, bytes, source: `https://huggingface.co/${publisher}/${id}`,
    installed: false, ready: false, readiness: 'missing-model', recommended: true, inUse: false, references: [] }] })
const modelState = { revision: 'fixture', usage: { subtitleRecognition: { model: 'kotoba', variant: 'kotoba-q4_k_m' },
  subtitleTranslation: { model: 'hy-mt2-7b', variant: 'hy-mt2-7b-q4_k_m' },
  textTranslation: { mode: 'local', model: 'qwen3', variant: 'qwen3-q4_k_m' } }, downloadSource: 'official', supported: true,
  directory: 'D:/模型存储/测试目录/较长的模型管理路径/models', defaultDirectory: 'D:/models', operation: null,
  activeModel: null, activeVariant: null, downloadBytes: 0, downloadTotal: 0, downloadLabel: null, error: null,
  models: [family('kotoba', 'Kotoba Whisper', 'kotoba-tech', 1520000000), family('qwen3', 'Qwen3 1.7B', 'bartowski', 1280000000),
    family('hy-mt2-7b', 'HY-MT2 7B', 'tencent', 4624648896),
    { ...family('qwen3-asr', 'Qwen3-ASR JA-Anime-Galgame', 'jaykwok', 4087640292), selectedVariant: 'qwen3-asr-bf16',
      variants: [{ ...family('qwen3-asr', 'Qwen3-ASR JA-Anime-Galgame', 'jaykwok', 4087640292).variants[0],
        id: 'qwen3-asr-bf16', precision: 'BF16', format: 'Safetensors' }] }] }
const asrComponents = [
  { ...runtimeComponentsFixture[0], id: 'audiocpp-cpu', group: 'qwen-speech', name: 'audio.cpp 语音引擎', version: 'v0.9.2-drama3-base-small' },
  { ...runtimeComponentsFixture[1], id: 'ffmpeg-qwen-common', group: 'qwen-speech' },
  { ...runtimeComponentsFixture[2], id: 'qwen-aligner-common', group: 'qwen-speech', name: 'Qwen3 ForcedAligner 0.6B', bytes: 1129966496 }
]
modelState.environments = ['speech', 'qwen-speech', 'text'].map(group => {
  const components = [...runtimeComponentsFixture, ...asrComponents].filter(item => item.group === group)
  const plan = runtimePlanFixture(group, components)
  return { group, components, supported: true, cpuReady: false, gpu: { state: 'unavailable' }, preparation: plan, gpuPreparation: plan }
})
let webStatus = { enabled: true, running: true, port: 8088, username: 'viewer', hasPassword: true,
  urls: ['http://192.168.1.20:8088'], devices: [], sessions: 0, pairingUntil: 0, pairingActivity: [], error: null }
window.api = { settings: { getLocalModels: async () => modelState, onLocalModelsChanged: () => () => {} },
  webAccess: { status: async () => webStatus,
    pairOpen: async () => { webStatus = { ...webStatus, pairingUntil: Date.now() + 300000 }; return webStatus },
    pairInspect: async () => ({ name: '合成测试设备', expires: Date.now() + 60000, remember: true }) } }
const [{ default: SettingsWorkspaceShell }, { default: LocalModelsPanel }, { default: LocalModelUsagePanel }, { default: WebAccessPanel }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell'),
  import('../../apps/desktop/src/renderer/src/components/settings/LocalModelsPanel'),
  import('../../apps/desktop/src/renderer/src/components/settings/LocalModelUsagePanel'),
  import('../../apps/desktop/src/renderer/src/components/settings/WebAccessPanel')
])
window.setSettingsTheme = applyTheme
applyTheme('slate')
function Fixture() {
  const [group, setGroup] = useState('models')
  const [tab, setTab] = useState('local')
  return <div style={{ display: 'flex', height: '100vh', minWidth: 0 }}>
    <aside style={{ width: 220, flex: '0 0 auto', padding: 24, background: 'var(--surface-panel)' }}>JAVDEX</aside>
    <main style={{ display: 'flex', flex: 1, minWidth: 0 }}>
      <SettingsWorkspaceShell activeGroup={SETTINGS_GROUPS.find(item => item.id === group)} activeTab={tab}
        onNavigate={(next, selected) => { setGroup(next); setTab(selected ?? (next === 'network' ? 'web' : 'local')) }} onTabKeyDown={() => {}}>
        {group === 'network' ? <WebAccessPanel /> : tab === 'usage' ? <LocalModelUsagePanel /> : <LocalModelsPanel />}
      </SettingsWorkspaceShell>
    </main>
  </div>
}
createRoot(document.getElementById('root')).render(<MemoryRouter><OverlayHistoryProvider><Fixture /></OverlayHistoryProvider></MemoryRouter>)
