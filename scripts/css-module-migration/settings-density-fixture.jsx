import React, { useState } from 'react'
import { Settings } from 'lucide-react'
import SettingsWorkspaceShell from '../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell'
import { SETTINGS_GROUPS } from '../../apps/desktop/src/renderer/src/settings/settingsRoutes'
import { SettingsNumberStepper, SettingsStatusPill } from '../../apps/desktop/src/renderer/src/components/settings/SettingsPrimitives'
import Button from '../../apps/desktop/src/renderer/src/components/Button'
import IconButton from '../../apps/desktop/src/renderer/src/components/IconButton'
import TextInput from '../../apps/desktop/src/renderer/src/components/TextInput'
import ListToolbar from '../../apps/desktop/src/renderer/src/components/ListToolbar'
import SelectionToolbar from '../../apps/desktop/src/renderer/src/components/SelectionToolbar'
import DetailActionBar from '../../apps/desktop/src/renderer/src/components/DetailActionBar'
import StorageSettingsPanel from '../../apps/desktop/src/renderer/src/components/settings/StorageSettingsPanel'
import MediaLibraryScanRunButton from '../../apps/desktop/src/renderer/src/components/settings/MediaLibraryScanRunButton'
import { SourcesSettingsTab } from '../../apps/desktop/src/renderer/src/pages/MediaLibrarySettingsTabs'
import libraryStyles from '../../apps/desktop/src/renderer/src/pages/MediaLibrarySettingsPage.module.css'

export default function SettingsDensityFixture({ variant }) {
  const [value, setValue] = useState(10)
  const [phase, setPhase] = useState('idle')
  const busy = phase === 'busy'
  const action = () => {
    window.densitySaveCount = (window.densitySaveCount ?? 0) + 1
    setPhase('busy')
    window.finishDensitySave = result => setPhase(result)
  }
  const library = { id: 1, name: '密度测试媒体库', status: 'active', activeRootCount: 1, pendingCleanupJobCount: 0, roots: [] }
  const body = variant === 'settingsDensityPanels' ? <div data-density-panels style={{ display: 'grid', gap: 12 }}>
    <SourcesSettingsTab library={library} formDisabled={busy} addRoots={async () => { window.densityPanelAction = 'roots' }} />
    <div className={libraryStyles.scanCommandRow}>
      <MediaLibraryScanRunButton className={libraryStyles.scanAction} library={library} formDisabled={busy}
        scan={{ running: false, cancelling: false, activeRunId: null, start: async () => { window.densityPanelAction = 'scan' }, cancel: async () => {} }} />
    </div>
    <StorageSettingsPanel settings={{ mediaAssetsPath: '/fixture/images', mediaAssetsResolvedPath: '/fixture/images', assetEncryption: false }}
      tab="assets" storageBusy={busy} onPickMediaAssetsPath={() => { window.densityPanelAction = 'path' }}
      onResetMediaAssetsPath={() => { window.densityPanelAction = 'reset' }} onToggleAssetEncryption={() => {}} onExportBlockingChange={() => {}} />
  </div> : <div data-density-controls style={{ display: 'grid', gap: 12, '--toolbar-control-h': '36px' }}>
    <div><SettingsStatusPill status="warning">需要处理</SettingsStatusPill></div>
    <SettingsNumberStepper aria-label="密度计数" value={value} min={0} max={100} unit="分钟" onChange={setValue} />
    <TextInput aria-label="普通输入" defaultValue="普通密度" />
    <TextInput density="workspace" aria-label="工作区输入" defaultValue="工作区密度" />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Button busy={busy} onClick={action}>保存</Button>
      <Button size="sm" disabled>禁用按钮</Button>
      <IconButton icon={<Settings size={16} />} label="密度图标" />
    </div>
    <ListToolbar title="列表操作" controls={<Button size="sm">工具栏按钮</Button>} />
    <SelectionToolbar countLabel="已选 1 项" actions={[{ key: 'apply', label: '批量按钮', onClick: () => {} }]} onClear={() => {}} />
    <DetailActionBar ariaLabel="详情操作" variant="inline" primary={{ label: '详情按钮', onClick: () => {} }} />
    <p role="status" style={{ margin: 0, minHeight: 24 }}>{phase === 'error' ? '保存失败，请重试' : phase === 'success' ? '保存成功' : '等待保存'}</p>
  </div>
  return variant === 'settingsDensityStandalone' ? <main style={{ padding: 24 }}>{body}</main>
    : <SettingsWorkspaceShell activeGroup={SETTINGS_GROUPS[0]} activeTab="status" onNavigate={() => {}} onTabKeyDown={() => {}}>{body}</SettingsWorkspaceShell>
}
