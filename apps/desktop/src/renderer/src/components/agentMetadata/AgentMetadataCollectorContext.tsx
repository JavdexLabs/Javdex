import Checkbox from '../../../../../../../packages/ui/src/Checkbox'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bot, Check, Database } from 'lucide-react'
import type {
  AgentMetadataDraft,
  AgentMetadataPlanInput,
  AgentMetadataReview,
  AgentMetadataSnapshot,
  AgentMetadataTarget,
  AgentMetadataTargetKind
} from '@shared/agentMetadataTypes'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  type ActressScrapeField,
  type ActressScrapeUpdateMode
} from '@shared/actressScrapeTypes'
import {
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS,
  type VideoScrapeField,
  type VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { api, resolveMediaSrc } from '../../api'
import {
  invalidateActressLibraryQueries,
  invalidateVideoLibraryQueries
} from '../../query/invalidateLibraryQueries'
import {
  AgentWorkspaceModal,
  AgentWorkspacePane,
  AgentWorkspacePaneBody,
  AgentWorkspacePaneHeader
} from '../AgentWorkspace'
import Button from '../Button'
import ConfirmModal from '../ConfirmModal'
import EmptyState from '../EmptyState'
import SelectControl from '../SelectControl'
import { useToast } from '../Toast'
import { UI_ICON_SM } from '../iconDefaults'
import { PendingImpactList, PendingImpactRow } from '../PendingDecisionParts'
import AgentMetadataActivityFeed from './AgentMetadataActivityFeed'
import styles from './AgentMetadataCollectorContext.module.css'

type OpenAgentMetadataTarget = AgentMetadataTarget & { label?: string }

interface AgentMetadataCollectorContextValue {
  open: (target: OpenAgentMetadataTarget, onApplied?: () => void) => void
}

const AgentMetadataCollectorContext = createContext<AgentMetadataCollectorContextValue | null>(null)

const TARGET_PRESENTATION = {
  video: {
    label: '影片',
    fields: VIDEO_SCRAPE_FIELD_OPTIONS,
    updateModes: VIDEO_SCRAPE_UPDATE_MODE_OPTIONS
  },
  actress: {
    label: '演员',
    fields: ACTRESS_SCRAPE_FIELD_OPTIONS,
    updateModes: ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS
  }
} satisfies Record<AgentMetadataTargetKind, {
  label: string
  fields: readonly { id: string; label: string }[]
  updateModes: readonly { id: string; label: string }[]
}>

export function useAgentMetadataCollector(): AgentMetadataCollectorContextValue {
  const value = useContext(AgentMetadataCollectorContext)
  if (!value) throw new Error('AgentMetadataCollectorProvider is missing')
  return value
}

function fieldOptions(kind: AgentMetadataTargetKind) {
  return TARGET_PRESENTATION[kind].fields
}

function updateModeOptions(kind: AgentMetadataTargetKind) {
  return TARGET_PRESENTATION[kind].updateModes
}

function formatValue(value: unknown): string {
  if (value == null || value === '') return '—'
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    return value.map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return String(item)
      if (item && typeof item === 'object' && 'name' in item) return String(item.name)
      return JSON.stringify(item)
    }).join('、')
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function actionLabel(action: string): string {
  return {
    set: '写入',
    replace: '替换',
    clear: '清空',
    append: '追加',
    preserve: '保留'
  }[action] ?? action
}

function resourceLabel(field: AgentMetadataDraft['resources'][number]['field']): string {
  return {
    cover: '封面',
    samples: '样张',
    actressAvatar: '演员头像',
    avatar: '头像',
    gallery: '写真'
  }[field]
}

function targetIdentity(target: OpenAgentMetadataTarget): AgentMetadataTarget {
  return { kind: target.kind, id: target.id }
}

function targetLabel(target: AgentMetadataTarget | null, label?: string): string {
  if (!target) return '外部详情页'
  const display = label?.trim()
  return display || TARGET_PRESENTATION[target.kind].label
}

function setupSubject(kind: AgentMetadataTargetKind | undefined): string {
  return kind === 'actress' ? '这位演员' : '这部影片'
}

function AgentMetadataSetupIntro({ kind }: { kind: AgentMetadataTargetKind | undefined }): JSX.Element {
  return (
    <div className={styles.intro}>
      <p>
        没有对应刮削器，或「修正匹配」缺封面、演员、剧情等字段时，把{setupSubject(kind)}的详情页交给
        Agent。它会打开页面抽取资料，先出现在右侧，不会直接改库。
      </p>
      <ol className={styles.steps}>
        <li>
          <span className={styles.stepCopy}>
            <strong>粘贴详情页</strong>
            使用该条目自己的资料页，不要用搜索页或列表页。
          </span>
        </li>
        <li>
          <span className={styles.stepCopy}>
            <strong>Agent 读取</strong>
            左侧显示采集过程；遇到验证码或登录时会暂停，请你处理后继续。
          </span>
        </li>
        <li>
          <span className={styles.stepCopy}>
            <strong>预览后写入</strong>
            右侧勾选字段和应用方式，确认后再写入媒体库。
          </span>
        </li>
      </ol>
    </div>
  )
}

function collectionIsActive(snapshot: AgentMetadataSnapshot | null): boolean {
  return Boolean(snapshot && ['collecting', 'preparing', 'waiting_user'].includes(snapshot.phase))
}

function reviewRoutesToPending(review: AgentMetadataReview | null): boolean {
  return Boolean(
    review && (
      (review.kind === 'video' && review.identityConflictVideoId) ||
      (review.kind === 'actress' && review.nameConflicts?.length)
    )
  )
}

export function AgentMetadataCollectorProvider({ children }: { children: ReactNode }): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [visible, setVisible] = useState(false)
  const [target, setTarget] = useState<AgentMetadataTarget | null>(null)
  const [targetDisplayLabel, setTargetDisplayLabel] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [snapshot, setSnapshot] = useState<AgentMetadataSnapshot | null>(null)
  const [draft, setDraft] = useState<AgentMetadataDraft | null>(null)
  const [review, setReview] = useState<AgentMetadataReview | null>(null)
  const [selectedFields, setSelectedFields] = useState<string[]>([])
  const [mode, setMode] = useState<VideoScrapeUpdateMode | ActressScrapeUpdateMode>('fillEmpty')
  const [directorSelectionId, setDirectorSelectionId] = useState<number | undefined>()
  const [identityConfirmed, setIdentityConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<'cancel' | 'discard' | null>(null)
  const currentRunId = useRef<string | null>(null)
  const currentDraftId = useRef<string | null>(null)
  const automaticPlanKey = useRef<string | null>(null)
  const openGeneration = useRef(0)
  const onAppliedRef = useRef<(() => void) | undefined>()

  const adoptDraft = useCallback((next: AgentMetadataDraft): void => {
    currentDraftId.current = next.id
    automaticPlanKey.current = null
    setDraft(next)
    setReview(null)
    setSelectedFields([...next.payload.observedFields])
    setMode('fillEmpty')
    setDirectorSelectionId(undefined)
    setIdentityConfirmed(false)
    setError(null)
    setConfirmation(null)
  }, [])

  const refreshSnapshot = useCallback(async (runId: string): Promise<void> => {
    try {
      const next = await api.agentMetadata.snapshot(runId)
      if (!next || currentRunId.current !== runId) return
      setSnapshot(next)
      if (next.draft && currentDraftId.current !== next.draft.id) adoptDraft(next.draft)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    }
  }, [adoptDraft])

  useEffect(() => api.agentMetadata.onSnapshotChanged((event) => {
    if (event.runId === currentRunId.current) void refreshSnapshot(event.runId)
  }), [refreshSnapshot])

  useEffect(() => {
    const runId = snapshot?.runId
    if (!visible || !runId || !['collecting', 'preparing', 'waiting_user'].includes(snapshot.phase)) return
    const timer = window.setInterval(() => void refreshSnapshot(runId), 1_500)
    return () => window.clearInterval(timer)
  }, [refreshSnapshot, snapshot?.phase, snapshot?.runId, visible])

  const runPlan = useCallback(async (input: {
    draft: AgentMetadataDraft
    fields: string[]
    nextMode: VideoScrapeUpdateMode | ActressScrapeUpdateMode
    directorId?: number
    identityConfirmed?: boolean
  }): Promise<void> => {
    automaticPlanKey.current = `${input.draft.id}:${input.draft.revision}`
    setBusy(true)
    setError(null)
    try {
      const planInput: AgentMetadataPlanInput = input.draft.payload.kind === 'video'
        ? {
            kind: 'video',
            draftId: input.draft.id,
            expectedRevision: input.draft.revision,
            fields: input.fields as VideoScrapeField[],
            mode: input.nextMode as VideoScrapeUpdateMode,
            ...(input.directorId ? { directorSelectionId: input.directorId } : {})
          }
        : {
            kind: 'actress',
            draftId: input.draft.id,
            expectedRevision: input.draft.revision,
            fields: input.fields as ActressScrapeField[],
            mode: input.nextMode as ActressScrapeUpdateMode,
            ...(input.identityConfirmed ? { identityConfirmed: true } : {})
          }
      const nextReview = await api.agentMetadata.plan(planInput)
      setReview(nextReview)
      setDraft((current) => current?.id === input.draft.id
        ? { ...current, revision: nextReview.revision }
        : current)
    } catch (planError) {
      if (input.directorId) {
        setDirectorSelectionId(undefined)
        automaticPlanKey.current = null
      }
      setError(planError instanceof Error ? planError.message : String(planError))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!visible || !draft || review || busy) return
    const key = `${draft.id}:${draft.revision}`
    if (automaticPlanKey.current === key) return
    void runPlan({ draft, fields: selectedFields, nextMode: mode })
  }, [busy, draft, mode, review, runPlan, selectedFields, visible])

  const open = useCallback((nextTarget: OpenAgentMetadataTarget, onApplied?: () => void): void => {
    const identity = targetIdentity(nextTarget)
    const generation = openGeneration.current + 1
    openGeneration.current = generation
    setVisible(true)
    setTarget(identity)
    setTargetDisplayLabel(nextTarget.label?.trim() ?? '')
    setSourceUrl('')
    setSnapshot(null)
    setDraft(null)
    setReview(null)
    setSelectedFields([])
    setMode('fillEmpty')
    setDirectorSelectionId(undefined)
    setIdentityConfirmed(false)
    setError(null)
    setBusy(true)
    currentRunId.current = null
    currentDraftId.current = null
    automaticPlanKey.current = null
    onAppliedRef.current = onApplied
    void (async () => {
      const ready = await api.agentMetadata.findReady(identity)
      if (openGeneration.current !== generation || !ready) return
      adoptDraft(ready)
      if (!ready.runId) return
      const recoveredSnapshot = await api.agentMetadata.snapshot(ready.runId)
      if (openGeneration.current !== generation || !recoveredSnapshot) return
      currentRunId.current = recoveredSnapshot.runId
      setSnapshot(recoveredSnapshot)
    })().catch((findError) => {
      if (openGeneration.current === generation) {
        setError(findError instanceof Error ? findError.message : String(findError))
      }
    }).finally(() => {
      if (openGeneration.current === generation) setBusy(false)
    })
  }, [adoptDraft])

  const hide = useCallback((): void => {
    openGeneration.current += 1
    setVisible(false)
    setConfirmation(null)
    currentRunId.current = null
    currentDraftId.current = null
    onAppliedRef.current = undefined
  }, [])

  const close = useCallback((): void => {
    if (collectionIsActive(snapshot)) {
      setConfirmation('cancel')
      return
    }
    hide()
  }, [hide, snapshot])

  const cancelAndClose = async (): Promise<void> => {
    const runId = currentRunId.current
    if (!runId) {
      hide()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.agentMetadata.cancel(runId)
      hide()
    } catch (cancelError) {
      setConfirmation(null)
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setBusy(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!target || !sourceUrl.trim()) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.agentMetadata.start({
        target,
        sourceUrl: sourceUrl.trim(),
        idempotencyKey: `renderer-start:${crypto.randomUUID()}`
      })
      currentRunId.current = next.runId
      setSnapshot(next)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError))
    } finally {
      setBusy(false)
    }
  }

  const changeFields = (field: string, checked: boolean): void => {
    if (!draft || busy) return
    const fields = checked
      ? [...selectedFields, field]
      : selectedFields.filter((item) => item !== field)
    setSelectedFields(fields)
    setReview(null)
    void runPlan({
      draft,
      fields,
      nextMode: mode,
      directorId: directorSelectionId,
      identityConfirmed
    })
  }

  const changeMode = (nextMode: VideoScrapeUpdateMode | ActressScrapeUpdateMode): void => {
    if (!draft || busy) return
    setMode(nextMode)
    setReview(null)
    void runPlan({
      draft,
      fields: selectedFields,
      nextMode,
      directorId: directorSelectionId,
      identityConfirmed
    })
  }

  const resume = async (): Promise<void> => {
    if (!snapshot?.handoff) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.agentMetadata.resume({
        runId: snapshot.runId,
        requestId: snapshot.handoff.requestId,
        idempotencyKey: `renderer-resume:${snapshot.handoff.requestId}`
      })
      setSnapshot(next)
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError))
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!draft || !review) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await api.agentMetadata.apply({
        draftId: draft.id,
        reviewToken: review.token,
        idempotencyKey: `renderer-apply:${draft.id}:${review.token}`
      })
      if (outcome.status === 'preview_stale') {
        setReview(outcome.review)
        setDraft((current) => current ? { ...current, revision: outcome.review.revision } : current)
        setError(outcome.warnings[0] ?? '预览已更新，请重新检查。')
        return
      }
      if (target?.kind === 'video') invalidateVideoLibraryQueries(queryClient)
      if (target?.kind === 'actress') await invalidateActressLibraryQueries(queryClient)
      onAppliedRef.current?.()
      toast.show(
        outcome.status === 'no_op'
          ? '没有需要写入的变化'
          : outcome.status === 'routed_to_pending'
            ? '冲突候选已转入待处理中心'
            : 'Agent 元数据已应用',
        'success'
      )
      setVisible(false)
      currentRunId.current = null
      currentDraftId.current = null
      onAppliedRef.current = undefined
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!draft) return
    setBusy(true)
    try {
      await api.agentMetadata.discard({ draftId: draft.id, expectedRevision: draft.revision })
      setVisible(false)
      currentRunId.current = null
      currentDraftId.current = null
      onAppliedRef.current = undefined
      toast.show('Agent 元数据草稿已丢弃')
    } catch (discardError) {
      setError(discardError instanceof Error ? discardError.message : String(discardError))
    } finally {
      setBusy(false)
    }
  }

  const contextValue = useMemo(() => ({ open }), [open])
  const modalTitle = `Agent 刮削 · ${targetLabel(target, targetDisplayLabel)}`
  const images = draft?.resources.filter((resource) =>
    ['cover', 'samples', 'actressAvatar', 'avatar', 'gallery'].includes(resource.field)
  ) ?? []

  return (
    <AgentMetadataCollectorContext.Provider value={contextValue}>
      {children}
      {visible ? (
        <AgentWorkspaceModal
          title={modalTitle}
          hint="和「修正匹配」不同：这里由你指定网页，Agent 读取后抽出资料，写入前必须预览确认。"
          busy={busy}
          dismissible={!busy}
          onCancel={close}
          actions={draft ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmation('discard')}>丢弃草稿</Button>
              <Button disabled={busy} onClick={close}>稍后处理</Button>
              <Button variant="primary" disabled={busy || !review?.canApply || selectedFields.length === 0} onClick={() => void apply()}>
                {reviewRoutesToPending(review) ? '转入待处理' : '应用所选字段'}
              </Button>
            </>
          ) : snapshot && ['collecting', 'preparing', 'waiting_user'].includes(snapshot.phase) ? (
            <>
              <Button disabled={busy} onClick={close}>终止</Button>
              {snapshot.phase === 'waiting_user' ? (
                <Button variant="primary" disabled={busy} onClick={() => void resume()}>我已完成，继续</Button>
              ) : null}
            </>
          ) : (
            <>
              <Button disabled={busy} onClick={close}>取消</Button>
              <Button variant="primary" disabled={busy || !sourceUrl.trim()} onClick={() => void start()}>开始采集</Button>
            </>
          )}
        >
          <AgentWorkspacePane label="Agent 运行">
              {snapshot ? (
                <AgentMetadataActivityFeed key={snapshot.runId} snapshot={snapshot} />
              ) : (
                <>
                  <AgentWorkspacePaneHeader
                    icon={<Bot {...UI_ICON_SM} aria-hidden />}
                    title="Agent 运行"
                    hint={draft
                      ? '已载入此前保存的采集草稿。'
                      : `粘贴${setupSubject(target?.kind)}的详情页地址。`}
                    status={draft ? '已完成' : '待开始'}
                  />
                  {draft ? (
                    <EmptyState
                      variant="fill"
                      icon={<Bot {...UI_ICON_SM} />}
                      title="历史采集已完成"
                      description="当前只保留采集结果；你可以在右侧继续预览和应用。"
                    />
                  ) : (
                    <AgentWorkspacePaneBody variant="setup">
                      <AgentMetadataSetupIntro kind={target?.kind} />
                      <div className={styles.sourceForm}>
                        <label htmlFor="agent-metadata-source-url">外部详情页 URL</label>
                        <input
                          id="agent-metadata-source-url"
                          className="text-input"
                          type="url"
                          inputMode="url"
                          autoFocus
                          placeholder="https://example.com/detail/..."
                          value={sourceUrl}
                          disabled={busy}
                          onChange={(event) => setSourceUrl(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && sourceUrl.trim() && !busy) void start()
                          }}
                        />
                      </div>
                    </AgentWorkspacePaneBody>
                  )}
                </>
              )}
          </AgentWorkspacePane>

          <AgentWorkspacePane label="结果预览">
              <AgentWorkspacePaneHeader
                icon={<Database {...UI_ICON_SM} aria-hidden />}
                title="结果预览"
                hint={draft
                  ? `来源：${draft.source.displayUrl}`
                  : '采集完成后在这里勾选要写入的字段。'}
                hintTitle={draft?.source.displayUrl}
                status={draft
                  ? `${draft.payload.observedFields.length} 个字段`
                  : collectionIsActive(snapshot) ? '采集中' : '等待结果'}
                ready={Boolean(draft)}
              />

              <AgentWorkspacePaneBody variant="result">
                {error ? <div className={styles.error} role="alert">{error}</div> : null}

                {draft ? (
                  <div className={styles.review}>
                    <section className={styles.controls} aria-label="应用设置">
                      <div className={styles.controlHeader}>
                        <div>
                          <strong>应用方式</strong>
                          <span>选择写入策略与字段后，下面会重新计算实际影响。</span>
                        </div>
                        <SelectControl
                          value={mode}
                          disabled={busy}
                          aria-label="应用方式"
                          onChange={(event) => changeMode(event.target.value as VideoScrapeUpdateMode | ActressScrapeUpdateMode)}
                        >
                          {updateModeOptions(draft.target.kind).map((option) => (
                            <option key={option.id} value={option.id}>{option.label}</option>
                          ))}
                        </SelectControl>
                      </div>
                      {mode === 'replace' ? (
                        <div className={styles.warning} role="status">
                          <AlertTriangle size={15} aria-hidden />覆盖更新会清空 Agent 明确观察为空的已选字段。
                        </div>
                      ) : null}
                      <div className={styles.fields}>
                        {fieldOptions(draft.target.kind)
                          .filter((option) => draft.payload.observedFields.includes(option.id as never))
                          .map((option) => (
                            <label key={option.id}>
                              <Checkbox
                                checked={selectedFields.includes(option.id)}
                                disabled={busy}
                                onChange={(event) => changeFields(option.id, event.target.checked)}
                              />
                              <span>{option.label}</span>
                              {draft.payload.explicitlyEmptyFields.includes(option.id as never) ? <em>页面为空</em> : null}
                            </label>
                          ))}
                      </div>
                    </section>

                    {images.length ? (
                      <section className={styles.assets} aria-label="已暂存图片">
                        {images.map((resource) => (
                          <figure key={`${resource.field}:${resource.position}`}>
                            <img src={resolveMediaSrc(resource.stagedPath) ?? ''} alt="" />
                            <figcaption>{resourceLabel(resource.field)} · {resource.position + 1}</figcaption>
                          </figure>
                        ))}
                      </section>
                    ) : null}

                    {review?.kind === 'video' && review.directorChoice ? (
                      <section className={styles.choice}>
                        <label htmlFor="agent-metadata-director">选择“{review.directorChoice.scrapedName}”对应的导演</label>
                        <SelectControl
                          id="agent-metadata-director"
                          value={directorSelectionId ?? ''}
                          disabled={busy}
                          onChange={(event) => {
                            const id = Number(event.target.value) || undefined
                            setDirectorSelectionId(id)
                            if (id && draft) {
                              setReview(null)
                              void runPlan({
                                draft,
                                fields: selectedFields,
                                nextMode: mode,
                                directorId: id,
                                identityConfirmed
                              })
                            }
                          }}
                        >
                          <option value="" disabled>请选择</option>
                          {review.directorChoice.candidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>{candidate.mainName}</option>
                          ))}
                        </SelectControl>
                      </section>
                    ) : null}

                    {review?.kind === 'actress' && review.requiresIdentityConfirmation ? (
                      <section className={styles.choice}>
                        <label htmlFor="agent-metadata-identity-confirmed">
                          页面名称与库内名称不一致，请在核对图片与资料后确认身份。
                        </label>
                        <label>
                          <Checkbox
                            id="agent-metadata-identity-confirmed"
                            checked={identityConfirmed}
                            disabled={busy}
                            onChange={(event) => {
                              const confirmed = event.target.checked
                              setIdentityConfirmed(confirmed)
                              if (draft) {
                                setReview(null)
                                void runPlan({
                                  draft,
                                  fields: selectedFields,
                                  nextMode: mode,
                                  directorId: directorSelectionId,
                                  identityConfirmed: confirmed
                                })
                              }
                            }}
                          />
                          <span>我确认这是同一位演员</span>
                        </label>
                      </section>
                    ) : null}

                    {review ? (
                      <section className={styles.impacts} aria-label="字段影响预览">
                        <div className={styles.impactHeader}>
                          <strong>字段影响</strong>
                          <span>{review.impacts.filter((impact) => impact.action !== 'preserve').length} 项会变化</span>
                        </div>
                        <PendingImpactList>
                          {review.impacts.map((impact, index) => {
                            const label = fieldOptions(review.kind).find((option) => option.id === impact.field)?.label ?? impact.field
                            return (
                              <PendingImpactRow
                                key={`${impact.field}:${'part' in impact ? impact.part ?? '' : ''}:${index}`}
                                label={`${label}${'part' in impact && impact.part ? ` · ${impact.part}` : ''}`}
                                current={formatValue(impact.currentValue)}
                                next={formatValue(impact.nextValue)}
                                action={<>{impact.action !== 'preserve' ? <Check size={13} aria-hidden /> : null}{actionLabel(impact.action)}</>}
                                clearing={impact.action === 'clear'}
                              />
                            )
                          })}
                        </PendingImpactList>
                      </section>
                    ) : null}

                    {review?.warnings.length ? (
                      <div className={styles.messages} role="status">
                        {review.warnings.map((warning, index) => <p key={`${warning}:${index}`}>{warning}</p>)}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <EmptyState
                    variant="fill"
                    loading={collectionIsActive(snapshot) || busy}
                    icon={<Database {...UI_ICON_SM} />}
                    title={snapshot?.phase === 'failed' ? '本次采集没有生成结果' : '等待采集结果'}
                    description={snapshot?.phase === 'failed'
                      ? '查看左侧最后一步和错误信息后，可以重新开始采集。'
                      : 'Agent 提交经过验证的字段后，在这里选择应用方式和要写入的内容。'}
                  />
                )}
              </AgentWorkspacePaneBody>
          </AgentWorkspacePane>
        </AgentWorkspaceModal>
      ) : null}
      {confirmation ? (
        <ConfirmModal
          title={confirmation === 'cancel' ? '终止本次 Agent 采集？' : '丢弃这份元数据草稿？'}
          confirmText={confirmation === 'cancel' ? '终止采集' : '丢弃草稿'}
          danger
          busy={busy}
          dismissible={!busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            if (confirmation === 'cancel') {
              void cancelAndClose()
              return
            }
            setConfirmation(null)
            void discard()
          }}
        >
          <p>
            {confirmation === 'cancel'
              ? '当前浏览器会话和正在进行的模型操作会立即停止，尚未生成的结果无法恢复。'
              : '草稿及其暂存图片会被删除，此操作无法撤销。'}
          </p>
        </ConfirmModal>
      ) : null}
    </AgentMetadataCollectorContext.Provider>
  )
}
