import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { Box, Check, ChevronRight, Eye, EyeOff, Search, RefreshCw } from 'lucide-react'
import type { LlmApiKeyAction, LlmProviderProtocol } from '@shared/llmProviders'
import { LLM_PROVIDER_PROTOCOL_OPTIONS } from '@shared/llmProviders'
import type { ModelCandidate, ModelManagementSnapshot } from '@shared/modelManagementTypes'
import Button from '../Button'
import IconButton from '../IconButton'
import SettingsFeedback from './SettingsFeedback'
import ModelTestFeedback from './ModelTestFeedback'
import SettingsFormActions from './SettingsFormActions'
import { useSettingsFormGuard } from '../../settings/SettingsLeaveGuard'
import ConfirmModal from '../ConfirmModal'
import Modal from '../Modal'
import SelectControl from '../SelectControl'
import type { ApplyModelManagementCommand } from './ModelSettingsPanel'
import { ModelOverrideCard } from './ModelAdvancedPanel'
import styles from './ProviderDetailModal.module.css'

type ModelTab = 'added' | 'discover' | 'manual'
type CandidateFilter = 'all' | 'pending' | 'added'
const modelTabs: { id: ModelTab; label: string }[] = [
  { id: 'added', label: '已添加' },
  { id: 'discover', label: '远程查询' },
  { id: 'manual', label: '手动添加' }
]

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
  const connection = snapshot.connections.find((item) => item.providerId === providerId)
  const models = useMemo(
    () => snapshot.models.filter((item) => item.connectionId === connection?.id),
    [connection?.id, snapshot.models]
  )
  const referencedModelRefs = useMemo(() => {
    const refs = new Set<string>()
    for (const assignment of snapshot.assignments) {
      if (assignment.resolution.modelRef) refs.add(assignment.resolution.modelRef)
      if (assignment.model.mode === 'explicit') refs.add(assignment.model.modelRef)
    }
    return refs
  }, [snapshot.assignments])
  const referencedConnectionIds = useMemo(
    () => new Set(snapshot.models
      .filter((model) => referencedModelRefs.has(model.id))
      .map((model) => model.connectionId)),
    [referencedModelRefs, snapshot.models]
  )
  const custom = !connection || connection.source === 'custom'
  const [connectionProviderId] = useState(
    () => providerId ?? `custom-${crypto.randomUUID()}`
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
  const [discovered, setDiscovered] = useState<ModelCandidate[] | null>(null)
  const [activeModelTab, setActiveModelTab] = useState<ModelTab>('added')
  const tabsId = useId()
  const [candidateSearch, setCandidateSearch] = useState('')
  const [candidateFilter, setCandidateFilter] = useState<CandidateFilter>('all')
  const [queryError, setQueryError] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [addMessage, setAddMessage] = useState<string | null>(null)
  const [addingModelId, setAddingModelId] = useState<string | null>(null)
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(() => new Set())
  const operationLock = useRef(false)
  const [remoteBusy, setRemoteBusy] = useState<'discover' | string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmModelRef, setConfirmModelRef] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const [dirtyModelRefs, setDirtyModelRefs] = useState<Set<string>>(() => new Set())
  const handleModelDirtyChange = useCallback((modelRef: string, dirty: boolean): void => {
    setDirtyModelRefs((current) => {
      if (dirty === current.has(modelRef)) return current
      const next = new Set(current)
      if (dirty) next.add(modelRef)
      else next.delete(modelRef)
      return next
    })
  }, [])
  const hasDirtyModelOverride = models.some((model) => dirtyModelRefs.has(model.id))
  const connectionValue = JSON.stringify({ name, protocol, baseUrl })
  const initial = useRef(connectionValue)
  const dirty = initial.current !== connectionValue || Boolean(apiKey) || apiKeyAction !== 'keep'
  const operationBusy = busy || saving || remoteBusy !== null || addingModelId !== null
  // A transient lock must not repaint every field with its disabled appearance.
  // Inert prevents edits and focus while retaining each control's normal styling.
  const setConnectionLock = useCallback((element: HTMLFieldSetElement | null): void => {
    if (element) element.inert = operationBusy
  }, [operationBusy])
  const addedIds = new Set([...models.map(model => model.modelId), ...addedModelIds])
  const duplicateModel = models.find(model => model.modelId === manualModelId.trim())
  const manualDuplicate = addedIds.has(manualModelId.trim())
  const candidates = (discovered ?? []).filter(candidate => {
    const matchesSearch = `${candidate.name}\n${candidate.id}`.toLocaleLowerCase().includes(candidateSearch.trim().toLocaleLowerCase())
    const added = addedIds.has(candidate.id)
    // Keep a just-added row in the pending view until the next explicit query.
    return matchesSearch && (candidateFilter === 'all' || (candidateFilter === 'added' ? added : !added || addedModelIds.has(candidate.id)))
  })
  const reset = (): void => {
    setSaveError(null)
    const saved = JSON.parse(initial.current) as {
      name: string
      protocol: LlmProviderProtocol
      baseUrl: string
    }
    setName(saved.name)
    setProtocol(saved.protocol)
    setBaseUrl(saved.baseUrl)
    setApiKey('')
    setApiKeyAction('keep')
  }

  const saveConnection = async (): Promise<boolean> => {
    if (operationBusy || operationLock.current) return false
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
    operationLock.current = true
    try {
      const saved = await apply(
        {
          type: 'save-connection',
          connection: {
            providerId: connectionProviderId,
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
        '提供商连接已保存',
        { onError: setSaveError, notifySuccess: false }
      )
      if (saved) {
        const nextValue = JSON.stringify({
          name: name.trim(),
          protocol,
          baseUrl: baseUrl.trim()
        })
        initial.current = nextValue
        setName(name.trim())
        setBaseUrl(baseUrl.trim())
        setApiKey('')
        setApiKeyAction('keep')
        setDiscovered(null)
        setQueryError(null)
        setAddError(null)
        setAddMessage(null)
        setTestResults({})
        setAddedModelIds(new Set())
        if (!connection) onProviderSaved(connectionProviderId)
      }
      return saved
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      operationLock.current = false
      setSaving(false)
    }
  }
  const requestClose = useSettingsFormGuard({
    label: '提供商连接',
    dirty,
    busy: operationBusy,
    save: saveConnection,
    discard: reset
  })

  const discover = async (): Promise<void> => {
    if (!connection || dirty || operationBusy || operationLock.current) return
    operationLock.current = true
    setRemoteBusy('discover')
    setQueryError(null)
    try {
      const result = await window.api.settings.discoverManagedModels(connection.id)
      setDiscovered(Array.from(new Map(result.map(candidate => [candidate.id, candidate])).values()))
      setAddedModelIds(new Set())
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : String(error))
    } finally {
      operationLock.current = false
      setRemoteBusy(null)
    }
  }

  const test = async (modelRef: string): Promise<void> => {
    if (dirty || operationBusy || operationLock.current) return
    operationLock.current = true
    setRemoteBusy(modelRef)
    try {
      const result = await window.api.settings.testManagedModel(modelRef)
      setTestResults(current => ({ ...current, [modelRef]: { ok: true, detail: result.sample } }))
    } catch (error) {
      setTestResults(current => ({ ...current, [modelRef]: { ok: false, detail: error instanceof Error ? error.message : String(error) } }))
    } finally {
      operationLock.current = false
      setRemoteBusy(null)
    }
  }

  const addModel = async (modelId: string, modelName: string, manual = false): Promise<boolean> => {
    if (!connection || dirty || operationBusy || operationLock.current || !modelId || addedIds.has(modelId)) return false
    operationLock.current = true
    setAddingModelId(modelId)
    setAddError(null)
    setAddMessage(null)
    let failure: string | null = null
    try {
      const added = await apply(
        {
          type: 'add-model',
          connectionId: connection.id,
          modelId,
          name: modelName || modelId
        },
        '模型已添加',
        { onError: message => { failure = message }, notifySuccess: false }
      )
      if (added) {
        setAddedModelIds(current => new Set([...current, modelId]))
        setAddMessage(`已添加“${modelName || modelId}”，可在“已添加”中测试与配置。`)
        if (manual) {
          setManualModelId('')
          setManualModelName('')
        }
      } else setAddError(failure || '模型未添加成功，输入与查询结果已保留，请重试。')
      return added
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      operationLock.current = false
      setAddingModelId(null)
    }
  }

  useSettingsFormGuard({
    label: '手动添加模型',
    dirty: Boolean(manualModelId.trim() || manualModelName.trim()),
    busy: addingModelId !== null,
    discard: () => { setManualModelId(''); setManualModelName(''); setAddError(null) }
  })

  const changeModelTab = (tab: ModelTab): void => {
    setActiveModelTab(tab)
    if (tab === 'discover' && discovered === null && !queryError) void discover()
  }

  return (
    <>
      <Modal
        title={connection ? connection.name : '添加提供商'}
        size="xl"
        className={styles.dialog}
        hint="配置服务连接并管理可用模型；模型用途在“功能”中选择。"
        hideActions
        onCancel={() => requestClose(onClose)}
        busy={operationBusy}
        bodyOverflow="hidden"
        bodyClassName={styles.modalBody}
      >
        <div className={styles.modalStack}>
          <section className={styles.modalSection}>
            <header className={styles.modalSectionHeader}>
              <h4 className={styles.sectionTitle}>连接配置</h4>
              <span className={styles.connectionStatus} data-ready={connection?.status === 'ready'}>
                {connection?.status === 'ready' ? '已就绪' : '尚未就绪'}
              </span>
            </header>
            <fieldset className={styles.gridTwo} ref={setConnectionLock} aria-busy={operationBusy || undefined} aria-label="提供商连接">
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
                <span>服务地址（Base URL）</span>
                <input
                  className={styles.controlInput}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <div className={styles.field}>
                <label htmlFor={`${tabsId}-key`}>API Key</label>
                <div className={styles.keyControl}>
                <input
                  className={styles.compositeInput}
                  id={`${tabsId}-key`}
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  autoComplete="new-password"
                  placeholder={
                    connection?.hasCredential ? '已安全保存；留空保持不变' : '输入 API Key'
                  }
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <IconButton size="sm" label={showKey ? '隐藏密钥' : '显示密钥'}
                  aria-pressed={showKey}
                  icon={showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  onClick={() => setShowKey(value => !value)} />
                </div>
              </div>
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
            <details className={styles.advancedConnection}>
              <summary className={styles.advancedConnectionSummary}>高级连接选项</summary>
              <fieldset className={`${styles.gridTwo} ${styles.advancedConnectionFields}`} ref={setConnectionLock} aria-busy={operationBusy || undefined} aria-label="高级连接选项">
                <label className={styles.field}>
                  <span>协议</span>
                  <SelectControl
                    value={protocol}
                    onChange={(event) => setProtocol(event.target.value as LlmProviderProtocol)}
                  >
                    {LLM_PROVIDER_PROTOCOL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                  </SelectControl>
                </label>
              </fieldset>
            </details>
            <SettingsFormActions
              dirty={dirty}
              idleLabel={connection ? '已保存' : '尚未配置'}
              error={saveError}
              saving={saving}
              disabled={operationBusy}
              saveLabel="保存连接"
              onSave={() => void saveConnection()}
              onCancel={reset}
            />
          </section>

          {connection ? (
            <section className={`${styles.modalSection} ${styles.modelsSection}`}>
              <header className={styles.modalSectionHeader}>
                <h4 className={styles.sectionTitle}>模型管理</h4>
              </header>
              <div className={styles.modelTabs} role="tablist" aria-label="模型管理">
                {modelTabs.map((tab, index) => <button key={tab.id} type="button"
                  role="tab" id={`${tabsId}-tab-${tab.id}`} aria-selected={activeModelTab === tab.id}
                  aria-controls={`${tabsId}-panel-${tab.id}`} tabIndex={activeModelTab === tab.id ? 0 : -1}
                  className={styles.modelTab} onClick={() => changeModelTab(tab.id)}
                  onKeyDown={event => {
                    let next: number
                    if (event.key === 'ArrowRight') next = (index + 1) % modelTabs.length
                    else if (event.key === 'ArrowLeft') next = (index + modelTabs.length - 1) % modelTabs.length
                    else if (event.key === 'Home') next = 0
                    else if (event.key === 'End') next = modelTabs.length - 1
                    else return
                    event.preventDefault()
                    changeModelTab(modelTabs[next].id)
                    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    buttons?.[next].focus()
                  }}>
                  {tab.label}{tab.id === 'added' ? <span className={styles.modelCount}>{models.length}</span> : null}
                </button>)}
              </div>
              <div role="tabpanel" id={`${tabsId}-panel-added`} aria-labelledby={`${tabsId}-tab-added`}
                hidden={activeModelTab !== 'added'}>
              <div className={styles.modelRows}>
                {models.length === 0 ? <div className={styles.empty}>尚未添加模型，可通过远程查询或手动添加。</div> : null}
                {models.map((model) => {
                  const modelInUse = referencedModelRefs.has(model.id)
                  const modelOverrideDirty = dirtyModelRefs.has(model.id)
                  const modelDeleteBlocked = operationBusy || dirty || modelInUse || modelOverrideDirty
                  const testResult = testResults[model.id]
                  return (
                    <details
                      key={model.id}
                      className={styles.modelDetail}
                      open={expandedModelId === model.id}
                      onToggle={(event) => {
                        if (event.target !== event.currentTarget) return
                        const open = event.currentTarget.open
                        setExpandedModelId((current) =>
                          open ? model.id : current === model.id ? null : current
                        )
                      }}
                    >
                      <summary className={styles.modelSummary}>
                        <span
                          className={styles.modelDisclosureIcon}
                          data-open={expandedModelId === model.id}
                          aria-hidden="true"
                        >
                          <ChevronRight size={14} />
                        </span>
                        <span className={styles.rowIdentity}>
                          <strong className={styles.truncate}>{model.name}</strong>
                          <small
                            className={`${styles.metaText} ${styles.truncate}`}
                            title={model.modelId}
                          >
                            {model.modelId}
                          </small>
                        </span>
                        <span className={styles.modelKind}>{model.builtin ? '内置' : '手动添加'}</span>
                        <span className={styles.modelUsage} data-in-use={modelInUse}>
                          {modelInUse ? '用途使用中' : '未被用途引用'}
                        </span>
                      </summary>
                      <div className={styles.modelDetailBody}>
                        <div className={styles.modelRow}>
                          <span className={styles.modelState}>
                            {model.kind === 'embedding' ? 'Embedding 模型' : '生成模型'}
                          </span>
                          <Button
                            size="sm"
                            busy={remoteBusy === model.id}
                            disabled={operationBusy || dirty || model.kind !== 'chat'}
                            onClick={() => void test(model.id)}
                          >
                            测试模型
                          </Button>
                          {!model.builtin ? (
                            <Button
                              size="sm" variant="danger"
                              disabled={modelDeleteBlocked}
                              title={modelInUse
                                ? '该模型仍被用途引用，请先更换用途模型'
                                : modelOverrideDirty
                                  ? '请先保存或取消能力与上限更改'
                                  : undefined}
                              onClick={() => {
                                if (modelDeleteBlocked) return
                                setConfirmModelRef(model.id)
                              }}
                            >
                              删除
                            </Button>
                          ) : null}
                        </div>
                        <ModelTestFeedback busy={remoteBusy === model.id} dirty={dirty} result={testResult} />
                        <ModelOverrideCard
                          snapshot={snapshot}
                          model={model}
                          busy={operationBusy}
                          apply={apply}
                          embedded
                          onDirtyChange={handleModelDirtyChange}
                        />
                      </div>
                    </details>
                  )
                })}
              </div>
              </div>
              <div role="tabpanel" id={`${tabsId}-panel-manual`} aria-labelledby={`${tabsId}-tab-manual`}
                hidden={activeModelTab !== 'manual'}>
              <form className={styles.manualModel} onSubmit={event => {
                event.preventDefault()
                void addModel(manualModelId.trim(), manualModelName.trim(), true)
              }}>
                <label className={styles.field}>
                  <span>模型 ID <small className={styles.metaText}>必填</small></span>
                  <input
                    className={styles.controlInput}
                    aria-label="模型 ID"
                    placeholder="模型 ID"
                    disabled={operationBusy}
                    value={manualModelId}
                    aria-describedby={`${tabsId}-manual-help`}
                    onChange={(event) => { setManualModelId(event.target.value); setAddError(null); setAddMessage(null) }}
                  />
                </label>
                <label className={styles.field}>
                  <span>显示名称（可选）</span>
                  <input
                    className={styles.controlInput}
                    aria-label="模型显示名称"
                    placeholder="显示名称（可选）"
                    disabled={operationBusy}
                    value={manualModelName}
                    onChange={(event) => { setManualModelName(event.target.value); setAddError(null); setAddMessage(null) }}
                  />
                </label>
                <p className={styles.sectionHint} id={`${tabsId}-manual-help`}>请填写服务商提供的完整模型 ID；名称留空时使用模型 ID。</p>
                <div className={styles.manualActions}>
                  <SettingsFeedback detailPresentation="inline" error={Boolean(addError)}
                    message={dirty ? '请先保存连接更改，再添加模型。'
                      : manualDuplicate ? '该模型已添加，无需重复添加。'
                        : addError || addMessage || '手动添加只登记模型，添加后可单独测试可用性。'} detail={addError} />
                  {duplicateModel ? <Button size="sm" onClick={() => {
                    setActiveModelTab('added'); setExpandedModelId(duplicateModel.id)
                  }}>查看已有模型</Button> : null}
                  <Button type="submit" size="sm" variant="primary" busy={addingModelId !== null}
                    disabled={!manualModelId.trim() || manualDuplicate || dirty || operationBusy}>添加模型</Button>
                </div>
              </form>
              </div>
              <div role="tabpanel" id={`${tabsId}-panel-discover`} aria-labelledby={`${tabsId}-tab-discover`}
                hidden={activeModelTab !== 'discover'}>
                <div className={styles.queryToolbar}>
                  <div className={styles.searchControl}>
                    <Search size={16} className={styles.candidateIcon} aria-hidden="true" />
                    <input type="search" className={styles.compositeInput} aria-label="搜索远程模型" placeholder="搜索模型名称或 ID"
                      value={candidateSearch} onChange={event => setCandidateSearch(event.target.value)} />
                  </div>
                  <Button size="sm" className={styles.queryAction} disabled={dirty || operationBusy} busy={remoteBusy === 'discover'}
                    onClick={() => void discover()}><RefreshCw size={14} aria-hidden="true" />
                    {discovered === null ? '查询远程模型' : '重新查询'}</Button>
                </div>
                <div className={styles.queryStatus}>
                  <span role={queryError ? 'alert' : 'status'} className={styles.metaText}>
                    {dirty ? '请先保存连接更改，再查询远程模型。'
                      : remoteBusy === 'discover' ? discovered === null ? '正在查询…' : '正在更新，暂时保留上次结果…'
                        : queryError ? discovered === null ? '查询失败，可重试或手动添加。' : '更新失败，当前显示上次结果。'
                          : discovered !== null ? `查询完成 · ${discovered.length} 个结果` : '查询和添加使用已保存的连接。'}
                  </span>
                  <div className={styles.queryFilters} role="group" aria-label="远程模型筛选">
                    {(['all', 'pending', 'added'] as const).map((filter, index) => <Button key={filter}
                      size="sm" className={styles.filterButton} aria-pressed={candidateFilter === filter} onClick={() => setCandidateFilter(filter)}>
                      {['全部', '待添加', '已添加'][index]}</Button>)}
                  </div>
                </div>
                {queryError ? <details className={styles.errorDetails}>
                  <summary className={styles.errorSummary}>查询错误详情</summary><p className={styles.responseText}>{queryError}</p>
                </details> : null}
                <div className={styles.discoveredList}>
                  {candidates.map((candidate) => {
                    const existingModel = models.find(model => model.modelId === candidate.id)
                    const added = addedIds.has(candidate.id)
                    return (
                    <div key={candidate.id} className={styles.discoveredRow}>
                      <Box size={18} className={styles.candidateIcon} aria-hidden="true" />
                      <span className={`${styles.rowIdentity} ${styles.candidateIdentity}`}>
                        <strong className={styles.truncate} title={candidate.name}>{candidate.name}</strong>
                        <small className={`${styles.metaText} ${styles.truncate}`} title={candidate.id}>
                          {candidate.id}
                        </small>
                      </span>
                      <span className={styles.candidateMeta}>
                        {existingModel?.builtin ? <span className={styles.modelKind}>内置</span> : null}
                        {existingModel && referencedModelRefs.has(existingModel.id) ? <span className={styles.modelUsage} data-in-use>用途使用中</span> : null}
                        {!added ? <span className={styles.metaText}>{candidate.kind === 'chat' ? '待添加' : '仅支持生成模型'}</span> : null}
                      </span>
                      {added ? <span className={styles.addedState}><Check size={14} aria-hidden="true" />已添加</span>
                        : <Button size="sm" variant="primary" busy={addingModelId === candidate.id}
                            disabled={candidate.kind !== 'chat' || dirty || operationBusy}
                            onClick={() => void addModel(candidate.id, candidate.name)}>添加</Button>}
                    </div>
                  )})}
                  {discovered !== null && candidates.length === 0 ? <div className={styles.empty}>
                    {discovered.length === 0 ? '服务未返回模型，可切换到“手动添加”。' : '没有符合条件的模型，请调整搜索或筛选。'}
                  </div> : null}
                </div>
                <SettingsFeedback detailPresentation="inline" error={Boolean(addError)}
                  message={addError || addMessage || '查询只读取列表；添加后可在“已添加”中测试与配置。'} detail={addError} />
              </div>
            </section>
          ) : null}

          {connection && custom ? (
            <section className={styles.dangerZone}>
              <div className={styles.dangerCopy}>
                <strong>删除自定义提供商</strong>
                <span className={styles.dangerHint}>
                  {referencedConnectionIds.has(connection.id)
                    ? '该提供商仍被用途引用，请先更换用途模型。'
                    : hasDirtyModelOverride
                      ? '请先保存或取消能力与上限更改，再删除提供商。'
                    : dirty
                      ? '请先保存或取消连接更改，再删除提供商。'
                      : '删除后将同时移除该连接下的自定义模型。'}
                </span>
              </div>
              <Button
                size="sm"
                variant="danger" disabled={operationBusy || dirty || hasDirtyModelOverride || referencedConnectionIds.has(connection.id)}
                title={referencedConnectionIds.has(connection.id)
                  ? '该提供商仍被用途引用'
                  : hasDirtyModelOverride
                    ? '请先保存或取消能力与上限更改'
                    : undefined}
                onClick={() => {
                  if (operationBusy || dirty || hasDirtyModelOverride || referencedConnectionIds.has(connection.id)) return
                  setConfirmDelete(true)
                }}
              >
                删除提供商…
              </Button>
            </section>
          ) : null}
        </div>
        <footer className={styles.dialogFooter}>
          <span className={styles.metaText}>用途绑定不会因添加模型而改变。</span>
          <Button size="sm" disabled={operationBusy} onClick={() => requestClose(onClose)}>关闭</Button>
        </footer>
      </Modal>
      {confirmDelete ? (
        <ConfirmModal
          title="删除提供商"
          confirmText="删除提供商"
          danger
          busy={busy || saving}
          confirmDisabled={!connection || dirty || hasDirtyModelOverride || referencedConnectionIds.has(connection.id)}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            if (!connection || busy || saving || dirty || hasDirtyModelOverride || referencedConnectionIds.has(connection.id)) return
            return apply(
              { type: 'remove-connection', connectionId: connection.id },
              '提供商已删除'
            ).then((ok) => {
              if (ok) {
                reset()
                onClose()
              }
            })
          }}
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
          busy={busy || saving || remoteBusy !== null}
          confirmDisabled={referencedModelRefs.has(confirmModelRef) || dirtyModelRefs.has(confirmModelRef)}
          onCancel={() => setConfirmModelRef(null)}
          onConfirm={() => {
            if (busy || saving || remoteBusy !== null || referencedModelRefs.has(confirmModelRef) || dirtyModelRefs.has(confirmModelRef)) return
            return apply({ type: 'remove-model', modelRef: confirmModelRef }, '模型已删除').then(
              (ok) => {
                if (ok) setConfirmModelRef(null)
                if (ok) {
                  const removed = models.find(model => model.id === confirmModelRef)
                  setAddedModelIds(current => {
                    const next = new Set(current)
                    if (removed) next.delete(removed.modelId)
                    return next
                  })
                }
              }
            )
          }}
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
