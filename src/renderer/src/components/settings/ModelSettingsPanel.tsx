import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { ModelManagementCommand, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import { api } from '../../api'
import { useToast } from '../Toast'
import ModelUsagePanel from './ModelUsagePanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import ModelAdvancedPanel from './ModelAdvancedPanel'
import styles from './ModelSettingsPanel.module.css'

export type ApplyModelManagementCommand = (
  command: ModelManagementCommand,
  successMessage?: string
) => Promise<boolean>

type ModelSettingsTab = 'usage' | 'providers' | 'advanced'

const MODEL_SETTINGS_TABS: ReadonlyArray<readonly [ModelSettingsTab, string]> = [
  ['usage', '用途与运行'],
  ['providers', '提供商与模型'],
  ['advanced', '高级']
]

function tabId(id: ModelSettingsTab): string {
  return `model-settings-tab-${id}`
}

export default function ModelSettingsPanel({ settings }: { settings: SettingsSnapshot }): JSX.Element {
  const toast = useToast()
  const [activeTab, setActiveTab] = useState<ModelSettingsTab>('usage')
  const [snapshot, setSnapshot] = useState<ModelManagementSnapshot | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    current: ModelSettingsTab
  ): void => {
    const currentIndex = MODEL_SETTINGS_TABS.findIndex(([id]) => id === current)
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % MODEL_SETTINGS_TABS.length
    if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + MODEL_SETTINGS_TABS.length) % MODEL_SETTINGS_TABS.length
    }
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = MODEL_SETTINGS_TABS.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = MODEL_SETTINGS_TABS[nextIndex]![0]
    setActiveTab(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`#${tabId(next)}`)
      ?.focus()
  }

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await api.settings.getModelManagement())
      setLoadingError(null)
    } catch (error) {
      setLoadingError((error as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const apply = useCallback<ApplyModelManagementCommand>(async (
    command,
    successMessage = '模型设置已保存'
  ) => {
    if (!snapshot || busy) return false
    setBusy(true)
    try {
      const result = await api.settings.applyModelManagement({
        expectedRevision: snapshot.revision,
        command
      })
      if (!result.ok) {
        const usages = result.error.usages?.length
          ? `（正在使用：${result.error.usages.join('、')}）`
          : ''
        toast.show(`${result.error.message}${usages}`, 'error')
        if (result.error.code === 'REVISION_CONFLICT') await refresh()
        return false
      }
      setSnapshot(result.snapshot)
      toast.show(successMessage, 'success')
      return true
    } catch (error) {
      toast.show((error as Error).message, 'error')
      return false
    } finally {
      setBusy(false)
    }
  }, [busy, refresh, snapshot, toast])

  return (
    <div className={styles.root}>
      {settings.llmSecretStorage.protection !== 'secure' ? (
        <div className={styles.warning} role="status">
          <strong>
            {settings.llmSecretStorage.protection === 'degraded'
              ? '系统凭证保护较弱'
              : '系统凭证存储不可用'}
          </strong>
          <span>
            {settings.llmSecretStorage.protection === 'degraded'
              ? `当前使用 ${settings.llmSecretStorage.backend}；API Key 仍与普通设置分离保存。`
              : '当前设备无法持久化新的 API Key，请先启用系统密钥环。'}
          </span>
        </div>
      ) : null}
      {settings.llmSecretStorage.migrationError ? (
        <div className={styles.warning} role="alert">
          <strong>旧版密钥尚未迁移</strong>
          <span>{settings.llmSecretStorage.migrationError}</span>
        </div>
      ) : null}

      <div className={styles.tabs} role="tablist" aria-label="模型设置">
        {MODEL_SETTINGS_TABS.map(([id, label]) => (
          <button
            key={id}
            id={tabId(id)}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            aria-controls="model-settings-tabpanel"
            tabIndex={activeTab === id ? 0 : -1}
            className={styles.tab}
            onClick={() => setActiveTab(id)}
            onKeyDown={(event) => handleTabKeyDown(event, id)}
          >
            {label}
          </button>
        ))}
      </div>

      {loadingError ? (
        <div className={styles.error} role="alert">
          <span>{loadingError}</span>
          <button className={styles.retryButton} type="button" onClick={() => void refresh()}>重试</button>
        </div>
      ) : !snapshot ? (
        <div className={styles.loading}>正在读取模型配置…</div>
      ) : (
        <div
          id="model-settings-tabpanel"
          className={styles.content}
          role="tabpanel"
          aria-labelledby={tabId(activeTab)}
        >
          {activeTab === 'usage' ? (
            <ModelUsagePanel snapshot={snapshot} busy={busy} apply={apply} />
          ) : activeTab === 'providers' ? (
            <ModelProvidersPanel snapshot={snapshot} busy={busy} apply={apply} />
          ) : (
            <ModelAdvancedPanel snapshot={snapshot} busy={busy} apply={apply} />
          )}
        </div>
      )}
    </div>
  )
}
