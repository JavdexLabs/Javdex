import { useMemo, useRef, useState } from 'react'
import type { LlmApiKeyAction, LlmProviderProtocol } from '@shared/llmProviders'
import type { ModelCandidate, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import Button from '../Button'
import SettingsFormActions from './SettingsFormActions'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import ConfirmModal from '../ConfirmModal'
import Modal from '../Modal'
import SelectControl from '../SelectControl'
import { useToast } from '../Toast'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import styles from './ProviderDetailModal.module.css'

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
  const [draftProviderId, setDraftProviderId] = useState(
    () => providerId ?? `custom-${crypto.randomUUID().slice(0, 8)}`
  )
  const [name, setName] = useState(connection?.name ?? '')
  const [protocol, setProtocol] = useState<LlmProviderProtocol>(
    connection?.protocol ?? 'openai-chat'
  )
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [apiKeyAction, setApiKeyAction] = useState<LlmApiKeyAction>('keep')
  const [manualModelId, setManualModelId] = useState('')
  const [manualModelName, setManualModelName] = useState('')
  const [discovered, setDiscovered] = useState<ModelCandidate[]>([])
  const [remoteBusy, setRemoteBusy] = useState<'discover' | string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmModelRef, setConfirmModelRef] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const connectionValue = JSON.stringify({ draftProviderId, name, protocol, baseUrl })
  const initial = useRef(connectionValue)
  const dirty = initial.current !== connectionValue || Boolean(apiKey) || apiKeyAction !== 'keep'
  const reset = (): void => {
    setSaveError(null)
    const saved = JSON.parse(initial.current) as {
      draftProviderId: string
      name: string
      protocol: LlmProviderProtocol
      baseUrl: string
    }
    setDraftProviderId(saved.draftProviderId)
    setName(saved.name)
    setProtocol(saved.protocol)
    setBaseUrl(saved.baseUrl)
    setApiKey('')
    setApiKeyAction('keep')
  }

  const saveConnection = async (): Promise<boolean> => {
    if (busy || saving) return false
    if (!name.trim() || !baseUrl.trim()) {
      setSaveError('请填写名称和完整的服务地址。')
      return false
    }
    try {
      if (!['http:', 'https:'].includes(new URL(baseUrl.trim()).protocol)) throw new Error()
    } catch {
      setSaveError('服务地址需要以 http:// 或 https:// 开头。')
      return false
    }
    if (apiKeyAction === 'replace' && !apiKey.trim()) {
      setSaveError('替换密钥时，请输入新的 API Key。')
      return false
    }
    setSaveError(null)
    setSaving(true)
    try {
      const normalizedId = draftProviderId
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
      const saved = await apply(
        {
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
        },
        '提供商连接已保存'
      )
      if (saved) {
        initial.current = connectionValue
        setApiKey('')
        setApiKeyAction('keep')
        setTestResult(null)
        if (!connection) onProviderSaved(normalizedId)
      }
      return saved
    } finally {
      setSaving(false)
    }
  }
  const requestClose = useSettingsFormGuard({
    label: '提供商连接',
    dirty,
    busy: saving,
    save: saveConnection,
    discard: reset
  })

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
    setTestResult(null)
    try {
      const result = await window.api.settings.testManagedModel(modelRef)
      setTestResult(`模型测试通过：${result.sample}`)
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setRemoteBusy(null)
    }
  }

  const addModel = async (modelId: string, modelName: string): Promise<void> => {
    if (!connection) return
    const added = await apply(
      {
        type: 'add-model',
        connectionId: connection.id,
        modelId,
        name: modelName || modelId
      },
      '模型已添加'
    )
    if (added) {
      setManualModelId('')
      setManualModelName('')
      setDiscovered((items) => items.filter((item) => item.id !== modelId))
    }
  }

  return (
    <>
      <Modal
        title={connection ? connection.name : '添加提供商'}
        size="lg"
        hideActions
        onCancel={() => requestClose(onClose)}
        busy={saving}
        bodyClassName={styles.modalBody}
      >
        <div className={styles.modalStack}>
          <section className={styles.modalSection}>
            <header className={styles.modalSectionHeader}>
              <h4 className={styles.sectionTitle}>连接</h4>
              <span>{connection?.status === 'ready' ? '已就绪' : '尚未就绪'}</span>
            </header>
            <fieldset className={styles.gridTwo} disabled={saving} aria-label="提供商连接">
              <label className={styles.field}>
                <span>连接标识（自动生成，可修改）</span>
                <input
                  className={styles.controlInput}
                  value={draftProviderId}
                  disabled={Boolean(connection)}
                  onChange={(event) => setDraftProviderId(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>名称</span>
                <input
                  className={styles.controlInput}
                  value={name}
                  disabled={connection?.source === 'builtin'}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>协议</span>
                <SelectControl
                  value={protocol}
                  onChange={(event) => setProtocol(event.target.value as LlmProviderProtocol)}
                >
                  <option value="openai-chat">OpenAI Chat Completions</option>
                  <option value="anthropic-messages">Anthropic Messages</option>
                </SelectControl>
              </label>
              <label className={styles.field}>
                <span>服务地址（Base URL）</span>
                <input
                  className={styles.controlInput}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>API Key</span>
                <input
                  className={styles.controlInput}
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  autoComplete="new-password"
                  placeholder={
                    connection?.hasCredential ? '已安全保存；留空保持不变' : '输入 API Key'
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label className={styles.field}>
                <span>密钥操作</span>
                <SelectControl
                  value={apiKey.trim() ? 'replace' : apiKeyAction}
                  disabled={Boolean(apiKey.trim())}
                  onChange={(event) => setApiKeyAction(event.target.value as LlmApiKeyAction)}
                >
                  <option value="keep">
                    {connection?.hasCredential ? '保留现有密钥' : '不设置密钥'}
                  </option>
                  <option value="replace">替换密钥</option>
                  {connection?.hasCredential ? <option value="clear">清除密钥</option> : null}
                </SelectControl>
              </label>
            </fieldset>
            <SettingsFormActions
              dirty={dirty}
              idleLabel={connection ? '已保存' : '尚未配置'}
              error={saveError}
              saving={saving}
              disabled={busy}
              onSave={() => void saveConnection()}
              onCancel={reset}
            >
              <Button size="sm" disabled={saving} onClick={() => setShowKey((value) => !value)}>
                {showKey ? '隐藏密钥' : '显示密钥'}
              </Button>
            </SettingsFormActions>
          </section>

          {connection ? (
            <section className={styles.modalSection}>
              <header className={styles.modalSectionHeader}>
                <h4 className={styles.sectionTitle}>模型</h4>
                <Button
                  size="sm"
                  disabled={remoteBusy !== null || dirty || busy}
                  onClick={() => void discover()}
                >
                  {remoteBusy === 'discover' ? '查询中…' : '查询远程模型'}
                </Button>
              </header>
              <p className={styles.metaText} role="status">
                {dirty
                  ? '连接有未保存的更改，请保存后再查询或测试模型。'
                  : '查询和测试使用已保存的连接；测试不会改变默认模型。'}
              </p>
              {testResult ? (
                <p className={styles.metaText} role="status">
                  {dirty ? '配置已更改，请保存后重新测试。' : testResult}
                </p>
              ) : null}
              <div className={styles.modelRows}>
                {models.map((model) => (
                  <div key={model.id} className={styles.modelRow}>
                    <span className={styles.rowIdentity}>
                      <strong className={styles.truncate}>{model.name}</strong>
                      <small
                        className={`${styles.metaText} ${styles.truncate}`}
                        title={model.modelId}
                      >
                        {model.modelId}
                      </small>
                    </span>
                    <span>{model.builtin ? '内置' : '自定义'}</span>
                    <Button
                      size="sm"
                      disabled={remoteBusy !== null || dirty || busy}
                      onClick={() => void test(model.id)}
                    >
                      {remoteBusy === model.id ? '测试中…' : '测试'}
                    </Button>
                    {!model.builtin ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmModelRef(model.id)}
                      >
                        删除
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              <div className={styles.manualModel}>
                <input
                  className={styles.controlInput}
                  aria-label="模型 ID"
                  placeholder="模型 ID"
                  value={manualModelId}
                  onChange={(event) => setManualModelId(event.target.value)}
                />
                <input
                  className={styles.controlInput}
                  aria-label="模型显示名称"
                  placeholder="显示名称（可选）"
                  value={manualModelName}
                  onChange={(event) => setManualModelName(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!manualModelId.trim() || busy}
                  onClick={() => void addModel(manualModelId.trim(), manualModelName.trim())}
                >
                  添加模型
                </Button>
              </div>
              {discovered.length > 0 ? (
                <div className={styles.discoveredList}>
                  {discovered.map((candidate) => (
                    <div key={candidate.id} className={styles.discoveredRow}>
                      <span className={styles.rowIdentity}>
                        <strong className={styles.truncate}>{candidate.name}</strong>
                        <small className={`${styles.metaText} ${styles.truncate}`}>
                          {candidate.id}
                        </small>
                      </span>
                      <span>
                        {candidate.kind === 'embedding' ? 'Embedding（不可添加）' : '生成模型'}
                      </span>
                      <Button
                        size="sm"
                        disabled={
                          candidate.kind !== 'chat' ||
                          busy ||
                          models.some((model) => model.modelId === candidate.id)
                        }
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
                <span className={styles.dangerHint}>
                  在被任何用途引用时，系统会拒绝删除并列出具体用途。
                </span>
              </div>
              <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                删除提供商…
              </Button>
            </section>
          ) : null}
        </div>
      </Modal>
      {confirmDelete ? (
        <ConfirmModal
          title="删除提供商"
          confirmText="删除提供商"
          danger
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            void apply(
              { type: 'remove-connection', connectionId: connection!.id },
              '提供商已删除'
            ).then((ok) => {
              if (ok) {
                reset()
                onClose()
              }
            })
          }
        >
          <p>
            将删除“{connection?.name}”及连接配置。仍被用途引用时无法删除，请先更换对应用途的模型。
          </p>
        </ConfirmModal>
      ) : null}
      {confirmModelRef ? (
        <ConfirmModal
          title="删除模型"
          confirmText="删除模型"
          danger
          busy={busy}
          onCancel={() => setConfirmModelRef(null)}
          onConfirm={() =>
            void apply({ type: 'remove-model', modelRef: confirmModelRef }, '模型已删除').then(
              (ok) => {
                if (ok) setConfirmModelRef(null)
              }
            )
          }
        >
          <p>
            将从可选模型中移除“{models.find((model) => model.id === confirmModelRef)?.name}
            ”。仍被用途引用时无法删除。
          </p>
        </ConfirmModal>
      ) : null}
    </>
  )
}
