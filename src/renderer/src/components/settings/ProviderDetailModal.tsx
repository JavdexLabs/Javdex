import { useMemo, useState } from 'react'
import type {
  LlmApiKeyAction,
  LlmProviderProtocol
} from '@shared/llmProviders'
import type { ModelCandidate, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import Button from '../Button'
import Modal from '../Modal'
import SelectControl from '../SelectControl'
import { useToast } from '../Toast'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import styles from './ModelSettingsPanel.module.css'

export default function ProviderDetailModal({
  providerId,
  snapshot,
  busy,
  apply,
  onProviderSaved,
  onClose
}: {
  providerId?: string
  snapshot: ModelManagementSnapshot
  busy: boolean
  apply: ApplyModelManagementCommand
  onProviderSaved: (providerId: string) => void
  onClose: () => void
}): JSX.Element {
  const toast = useToast()
  const connection = snapshot.connections.find((item) => item.providerId === providerId)
  const models = useMemo(
    () => snapshot.models.filter((item) => item.connectionId === connection?.id),
    [connection?.id, snapshot.models]
  )
  const custom = !connection || connection.source === 'custom'
  const [draftProviderId, setDraftProviderId] = useState(providerId ?? '')
  const [name, setName] = useState(connection?.name ?? '')
  const [protocol, setProtocol] = useState<LlmProviderProtocol>(connection?.protocol ?? 'openai-chat')
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyAction, setApiKeyAction] = useState<LlmApiKeyAction>('keep')
  const [manualModelId, setManualModelId] = useState('')
  const [manualModelName, setManualModelName] = useState('')
  const [discovered, setDiscovered] = useState<ModelCandidate[]>([])
  const [remoteBusy, setRemoteBusy] = useState<'discover' | string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmModelRef, setConfirmModelRef] = useState<string | null>(null)

  const saveConnection = async (): Promise<void> => {
    const normalizedId = draftProviderId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    const saved = await apply({
      type: 'save-connection',
      connection: {
        providerId: normalizedId,
        name: name.trim(),
        source: connection?.source ?? 'custom',
        protocol,
        baseUrl: baseUrl.trim(),
        local: connection?.local,
        agentCompatible: connection?.agentCompatible ?? true,
        enabled: true,
        apiKeyAction: apiKey.trim() ? 'replace' : apiKeyAction,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      }
    }, '提供商连接已保存')
    if (saved && !connection) onProviderSaved(normalizedId)
  }

  const discover = async (): Promise<void> => {
    if (!connection) return
    setRemoteBusy('discover')
    try {
      setDiscovered(await window.api.settings.discoverManagedModels(connection.id))
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  const test = async (modelRef: string): Promise<void> => {
    setRemoteBusy(modelRef)
    try {
      const result = await window.api.settings.testManagedModel(modelRef)
      toast.show(`模型连接正常：${result.sample}`, 'success')
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  const addModel = async (modelId: string, modelName: string): Promise<void> => {
    if (!connection) return
    const added = await apply({
      type: 'add-model',
      connectionId: connection.id,
      modelId,
      name: modelName || modelId
    }, '模型已添加')
    if (added) {
      setManualModelId('')
      setManualModelName('')
      setDiscovered((items) => items.filter((item) => item.id !== modelId))
    }
  }

  return (
    <Modal
      title={connection ? connection.name : '添加提供商'}
      size="lg"
      hideActions
      onCancel={onClose}
      bodyClassName={styles.modalBody}
    >
      <div className={styles.modalStack}>
        <section className={styles.modalSection}>
          <header className={styles.modalSectionHeader}><h4 className={styles.sectionTitle}>连接</h4><span>{connection?.status === 'ready' ? '已就绪' : '尚未就绪'}</span></header>
          <div className={styles.gridTwo}>
            <label className={styles.field}>
              <span>提供商 ID</span>
              <input className={styles.controlInput} value={draftProviderId} disabled={Boolean(connection)} onChange={(event) => setDraftProviderId(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>名称</span>
              <input className={styles.controlInput} value={name} disabled={connection?.source === 'builtin'} onChange={(event) => setName(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>协议</span>
              <SelectControl value={protocol} onChange={(event) => setProtocol(event.target.value as LlmProviderProtocol)}>
                <option value="openai-chat">OpenAI Chat Completions</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </SelectControl>
            </label>
            <label className={styles.field}>
              <span>Base URL</span>
              <input className={styles.controlInput} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>API Key</span>
              <input
                className={styles.controlInput}
                type="password"
                value={apiKey}
                autoComplete="new-password"
                placeholder={connection?.hasCredential ? '已安全保存；留空保持不变' : '输入 API Key'}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>密钥操作</span>
              <SelectControl value={apiKey.trim() ? 'replace' : apiKeyAction} disabled={Boolean(apiKey.trim())} onChange={(event) => setApiKeyAction(event.target.value as LlmApiKeyAction)}>
                <option value="keep">保留现有密钥</option>
                <option value="replace">替换密钥</option>
                <option value="clear">清除密钥</option>
              </SelectControl>
            </label>
          </div>
          <div className={styles.modalActions}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveConnection()}>
              {busy ? '保存中…' : '保存连接'}
            </Button>
          </div>
        </section>

        {connection ? (
          <section className={styles.modalSection}>
            <header className={styles.modalSectionHeader}>
              <h4 className={styles.sectionTitle}>模型</h4>
              <Button size="sm" disabled={remoteBusy !== null} onClick={() => void discover()}>
                {remoteBusy === 'discover' ? '查询中…' : '查询远程模型'}
              </Button>
            </header>
            <div className={styles.modelRows}>
              {models.map((model) => (
                <div key={model.id} className={styles.modelRow}>
                  <span className={styles.rowIdentity}><strong className={styles.truncate}>{model.name}</strong><small className={`${styles.metaText} ${styles.truncate}`} title={model.modelId}>{model.modelId}</small></span>
                  <span>{model.builtin ? '内置' : '自定义'}</span>
                  <Button size="sm" disabled={remoteBusy !== null} onClick={() => void test(model.id)}>
                    {remoteBusy === model.id ? '测试中…' : '测试'}
                  </Button>
                  {!model.builtin ? (
                    confirmModelRef === model.id ? (
                      <div className={styles.inlineConfirm}>
                        <Button size="sm" onClick={() => setConfirmModelRef(null)}>取消</Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={busy}
                          onClick={() => void apply(
                            { type: 'remove-model', modelRef: model.id },
                            '模型已删除'
                          ).then((ok) => { if (ok) setConfirmModelRef(null) })}
                        >
                          确认
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => setConfirmModelRef(model.id)}>
                        删除
                      </Button>
                    )
                  ) : null}
                </div>
              ))}
            </div>
            <div className={styles.manualModel}>
              <input className={styles.controlInput} placeholder="模型 ID" value={manualModelId} onChange={(event) => setManualModelId(event.target.value)} />
              <input className={styles.controlInput} placeholder="显示名称（可选）" value={manualModelName} onChange={(event) => setManualModelName(event.target.value)} />
              <Button size="sm" variant="primary" disabled={!manualModelId.trim() || busy} onClick={() => void addModel(manualModelId.trim(), manualModelName.trim())}>
                添加模型
              </Button>
            </div>
            {discovered.length > 0 ? (
              <div className={styles.discoveredList}>
                {discovered.map((candidate) => (
                  <div key={candidate.id} className={styles.discoveredRow}>
                    <span className={styles.rowIdentity}><strong className={styles.truncate}>{candidate.name}</strong><small className={`${styles.metaText} ${styles.truncate}`}>{candidate.id}</small></span>
                    <span>{candidate.kind === 'embedding' ? 'Embedding（不可添加）' : '生成模型'}</span>
                    <Button
                      size="sm"
                      disabled={candidate.kind !== 'chat' || busy || models.some((model) => model.modelId === candidate.id)}
                      onClick={() => void addModel(candidate.id, candidate.name)}
                    >
                      添加
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {connection && custom ? (
          <section className={styles.dangerZone}>
            <div className={styles.dangerCopy}>
              <strong>删除自定义提供商</strong>
              <span className={styles.dangerHint}>在被任何用途引用时，系统会拒绝删除并列出具体用途。</span>
            </div>
            {confirmDelete ? (
              <div className={styles.modalActions}>
                <Button size="sm" onClick={() => setConfirmDelete(false)}>取消</Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void apply({ type: 'remove-connection', connectionId: connection.id }, '提供商已删除').then((ok) => { if (ok) onClose() })}>
                  确认删除
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => setConfirmDelete(true)}>删除提供商</Button>
            )}
          </section>
        ) : null}
      </div>
    </Modal>
  )
}
