import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Cloud, HardDrive } from 'lucide-react'
import { UI_ICON_SM } from '../iconDefaults'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { ModelManagementCommand, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import { api } from '../../api'
import { useToast } from '../Toast'
import Button from '../Button'
import ModelUsagePanel, { ModelAgentUsagePanel } from './ModelUsagePanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import LocalModelsPanel from './LocalModelsPanel'
import LocalModelUsagePanel from './LocalModelUsagePanel'
import styles from './ModelSettingsPanel.module.css'
import { settingsPath } from '../../settings/settingsRoutes'

export type ApplyModelManagementCommand = (
  command: ModelManagementCommand,
  successMessage?: string,
  feedback?: { onError: (message: string) => void; notifySuccess?: boolean }
) => Promise<boolean>

export type ModelSettingsTab = 'usage' | 'providers' | 'local'

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
    async (command, successMessage = '模型设置已保存', feedback) => {
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
          if (feedback) feedback.onError(`${result.error.message}${usages}`)
          else toast.show(`${result.error.message}${usages}`, 'error')
          if (result.error.code === 'REVISION_CONFLICT') await refresh()
          return false
        }
        snapshotRef.current = result.snapshot
        setSnapshot(result.snapshot)
        if (feedback?.notifySuccess !== false) toast.show(successMessage, 'success')
        return true
      } catch (error) {
        if (feedback) feedback.onError((error as Error).message)
        else toast.show((error as Error).message, 'error')
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
      {activeTab === 'providers' && settings.llmSecretStorage.protection !== 'secure' ? (
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
      {activeTab === 'providers' && settings.llmSecretStorage.migrationError ? (
        <div className={styles.warning} role="alert">
          <strong>旧版密钥尚未迁移</strong>
          <span>{settings.llmSecretStorage.migrationError}</span>
        </div>
      ) : null}

      {loadingError && activeTab !== 'local' ? (
        <div className={styles.error} role="alert">
          <span>{loadingError}</span>
          <button className={styles.retryButton} type="button" onClick={() => void refresh()}>
            重试
          </button>
        </div>
      ) : null}
      {!snapshot && !loadingError && activeTab !== 'local' ? (
        <div className={styles.loading}>正在读取模型配置…</div>
      ) : null}
        <div id="model-settings-tabpanel" className={styles.content}>
          <div hidden={activeTab !== 'usage'}>
            <div className={styles.usageStack}>
            {snapshot ? <>
              {!snapshot.connections.some((c) => c.status === 'ready') ? (
                <section className={styles.onboarding}>
                  <div>
                    <h3 className={styles.onboardingTitle}>开始使用 AI 功能</h3>
                    <p className={styles.onboardingHint}>
                      AI 功能需要模型驱动。选择一种方式开始，之后随时可以在不同页签中添加更多服务与模型。
                    </p>
                  </div>
                  <div className={styles.paths}>
                    <div className={styles.pathCard}>
                      <div className={styles.pathCardHeader}>
                        <Cloud {...UI_ICON_SM} className={styles.pathCardIcon} />
                        <span>连接云端服务</span>
                      </div>
                      <ul className={styles.pathList}>
                        <li>使用 DeepSeek、OpenAI、Gemini 等在线模型</li>
                        <li>需填写 API Key，通常按用量计费</li>
                        <li>适合：翻译、插件开发助手、媒体库整理助手</li>
                      </ul>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() =>
                          navigate({
                            pathname: settingsPath('models', 'providers'),
                            search: location.search
                          })
                        }
                      >
                        连接云端服务
                      </Button>
                    </div>
                    <div className={styles.pathCard}>
                      <div className={styles.pathCardHeader}>
                        <HardDrive {...UI_ICON_SM} className={styles.pathCardIcon} />
                        <span>下载本地模型</span>
                      </div>
                      <ul className={styles.pathList}>
                        <li>在本机离线运行，免 API Key、不上传数据</li>
                        <li>需下载 1–5 GB 模型文件到本机</li>
                        <li>适合：AI 字幕、本地标题与简介翻译</li>
                      </ul>
                      <Button
                        size="sm"
                        onClick={() =>
                          navigate({
                            pathname: settingsPath('models', 'local'),
                            search: location.search
                          })
                        }
                      >
                        浏览本地模型
                      </Button>
                    </div>
                  </div>
                </section>
              ) : !snapshot.assignments.find((item) => item.workloadId === 'app-default')?.resolution
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
              <ModelUsagePanel snapshot={snapshot} busy={busy} apply={apply} defaultOnly />
            </> : null}
            <LocalModelUsagePanel layoutReady={snapshot !== null || loadingError !== null}
              appDefaultReady={snapshot?.assignments.find(item => item.workloadId === 'app-default')?.resolution.ready === true} />
            {snapshot ? <ModelAgentUsagePanel snapshot={snapshot} busy={busy} apply={apply} /> : null}
            </div>
          </div>
          {activeTab === 'providers' && snapshot ? (
            <ModelProvidersPanel snapshot={snapshot} busy={busy} apply={apply} />
          ) : null}
          {activeTab === 'local' ? <LocalModelsPanel /> : null}
        </div>
    </div>
  )
}
