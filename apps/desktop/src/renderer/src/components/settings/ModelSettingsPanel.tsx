import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { ModelManagementCommand, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import { api } from '../../api'
import { useToast } from '../Toast'
import Button from '../Button'
import ModelUsagePanel from './ModelUsagePanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import ModelAdvancedPanel from './ModelAdvancedPanel'
import styles from './ModelSettingsPanel.module.css'
import { settingsPath } from '../../settings/settingsRoutes'

export type ApplyModelManagementCommand = (
  command: ModelManagementCommand,
  successMessage?: string
) => Promise<boolean>

export type ModelSettingsTab = 'usage' | 'providers' | 'advanced'

export default function ModelSettingsPanel({
  settings,
  activeTab
}: {
  settings: SettingsSnapshot
  activeTab: ModelSettingsTab
}): JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [snapshot, setSnapshot] = useState<ModelManagementSnapshot | null>(null)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const snapshotRef = useRef(snapshot)
  const busyRef = useRef(false)
  snapshotRef.current = snapshot

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await api.settings.getModelManagement())
      setLoadingError(null)
    } catch (error) {
      setLoadingError((error as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const apply = useCallback<ApplyModelManagementCommand>(
    async (command, successMessage = '模型设置已保存') => {
      if (!snapshotRef.current || busyRef.current) return false
      busyRef.current = true
      setBusy(true)
      try {
        const result = await api.settings.applyModelManagement({
          expectedRevision: snapshotRef.current.revision,
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
        snapshotRef.current = result.snapshot
        setSnapshot(result.snapshot)
        toast.show(successMessage, 'success')
        return true
      } catch (error) {
        toast.show((error as Error).message, 'error')
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [refresh, toast]
  )

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

      {loadingError ? (
        <div className={styles.error} role="alert">
          <span>{loadingError}</span>
          <button className={styles.retryButton} type="button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : !snapshot ? (
        <div className={styles.loading}>正在读取模型配置…</div>
      ) : (
        <div id="model-settings-tabpanel" className={styles.content}>
          {activeTab === 'usage' ? (
            <>
              {!snapshot.assignments.find((item) => item.workloadId === 'app-default')?.resolution
                .ready ? (
                <div className={styles.warning}>
                  <span>
                    先配置提供商并添加可用模型，再选择应用默认模型。AI 助手默认继承此选择。
                  </span>
                  <Button
                    size="sm"
                    onClick={() =>
                      navigate({
                        pathname: settingsPath('models', 'providers'),
                        search: location.search
                      })
                    }
                  >
                    配置提供商与模型
                  </Button>
                </div>
              ) : null}
              <ModelUsagePanel snapshot={snapshot} busy={busy} apply={apply} />
            </>
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
