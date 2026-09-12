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
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Bot, Database, ExternalLink } from 'lucide-react'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import PlaylistDestinationPicker from '../PlaylistDestinationPicker'
import type {
  PlaylistImportPreviewItem,
  PlaylistImportSnapshot
} from '@shared/playlistImportTypes'
import { api } from '../../api'
import {
  AgentWorkspaceModal,
  AgentWorkspacePane,
  AgentWorkspacePaneBody,
  AgentWorkspacePaneHeader
} from '../AgentWorkspace'
import Button from '../Button'
import ConfirmModal from '../ConfirmModal'
import EmptyState from '../EmptyState'
import { EditFormField, EditFormSection } from '../FormPrimitives'
import SelectControl from '../SelectControl'
import SettingsSwitchRow from '../SettingsSwitchRow'
import { useToast } from '../Toast'
import { UI_ICON_SM } from '../iconDefaults'
import { invalidateVideoLibraryQueries } from '../../query/invalidateLibraryQueries'
import AgentMetadataActivityFeed from '../agentMetadata/AgentMetadataActivityFeed'
import styles from './PlaylistImportContext.module.css'
import PlaylistImportIdentityReview, {
  type PlaylistImportIdentityChoice
} from './PlaylistImportIdentityReview'
import { notifyPlaylistImportCompleted } from './events'

interface PlaylistImportOpenInput {
  destination?: { kind: 'append'; playlistId: number; playlistName: string } | { kind: 'create' }
}

interface PlaylistImportContextValue {
  open(input?: PlaylistImportOpenInput): void
}

const PlaylistImportContext = createContext<PlaylistImportContextValue | null>(null)

function openExternalLink(url: string): void {
  void api.externalLinks.open(url)
}

export function usePlaylistImport(): PlaylistImportContextValue {
  const value = useContext(PlaylistImportContext)
  if (!value) throw new Error('PlaylistImportProvider is missing')
  return value
}

function isRunning(snapshot: PlaylistImportSnapshot | null): boolean {
  return Boolean(snapshot && [
    'discovering-list',
    'resolving-identities',
    'ready-to-apply',
    'applying'
  ].includes(snapshot.phase))
}

function phaseLabel(snapshot: PlaylistImportSnapshot): string {
  if (snapshot.phase === 'discovering-list') return '读取清单'
  if (snapshot.phase === 'resolving-identities') return '核对身份'
  if (snapshot.phase === 'waiting_user') return '等待确认'
  if (snapshot.phase === 'ready-to-apply' || snapshot.phase === 'applying') return '正在写入'
  if (snapshot.phase === 'completed') return '已完成'
  if (snapshot.phase === 'failed') return '失败'
  if (snapshot.phase === 'cancelled') return '已取消'
  return snapshot.phase
}

function phaseHint(snapshot: PlaylistImportSnapshot): string {
  if (snapshot.phase === 'discovering-list') return '正在读取分页或虚拟滚动窗口，并逐页固化候选。'
  if (snapshot.phase === 'resolving-identities') return '正在用详情页消除跨媒体库重复候选。'
  if (snapshot.attention?.kind === 'browser-handoff') return '已暂停，请在浏览器完成必要操作后继续。'
  if (snapshot.attention?.kind === 'identity-review') return '请在右侧结果预览中处理仍有歧义的影片。'
  if (snapshot.phase === 'completed') return '清单和影片引用已经原子写入。'
  if (snapshot.phase === 'failed') return '查看最后一步和错误信息定位失败原因。'
  return 'Agent 会持续更新右侧发现与匹配结果。'
}

function previewStatus(item: PlaylistImportPreviewItem): string {
  if (item.errorCode === 'AUTO_CREATE_DISABLED') return '已跳过'
  if (item.state === 'needs-detail') return '核对详情'
  if (item.state === 'needs-user') return '待你选择'
  if (item.state === 'planned-reuse') return '复用已有'
  if (item.state === 'planned-create') return '新建无资源'
  if (item.state === 'applied') {
    return item.resolutionKind?.includes('create') ? '已新建' : '已复用'
  }
  if (item.state === 'failed') return '处理失败'
  return '已发现'
}

export function PlaylistImportProvider({ children }: { children: ReactNode }): JSX.Element {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [visible, setVisible] = useState(false)
  const [sourceUrl, setSourceUrl] = useState('')
  const [destinationKind, setDestinationKind] = useState<'create' | 'append'>('create')
  const [requestedName, setRequestedName] = useState('')
  const [playlistId, setPlaylistId] = useState('')
  const [playlistLabel,setPlaylistLabel] = useState('')
  const optionsGeneration = useRef(0)
  useEffect(()=>{if(!visible)optionsGeneration.current++},[visible])
  const [targetLibraryId, setTargetLibraryId] = useState('')
  const [autoCreateUnmatchedVideos, setAutoCreateUnmatchedVideos] = useState(true)
  const [saveDetailLinks, setSaveDetailLinks] = useState(true)
  const [saveSourcePlaylistLink, setSaveSourcePlaylistLink] = useState(false)
  const [libraries, setLibraries] = useState<MediaLibrarySummary[]>([])
  const [snapshot, setSnapshot] = useState<PlaylistImportSnapshot | null>(null)
  const [choices, setChoices] = useState<Record<number, PlaylistImportIdentityChoice>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelConfirmation, setCancelConfirmation] = useState(false)
  const currentRunId = useRef<string | null>(null)
  const completionSeen = useRef<string | null>(null)
  const identityReviewChoiceKey = snapshot?.attention?.kind === 'identity-review'
    ? JSON.stringify(snapshot.attention.items.map((item) => ({
        itemId: item.itemId,
        itemRevision: item.itemRevision,
        candidateIds: item.candidates.map((candidate) => candidate.videoId)
      })))
    : ''

  const refresh = useCallback(async (runId: string): Promise<void> => {
    const next = await api.playlistImport.snapshot(runId)
    if (!next || currentRunId.current !== runId) return
    setSnapshot(next)
  }, [])

  useEffect(() => api.playlistImport.onSnapshotChanged((event) => {
    if (event.runId === currentRunId.current) void refresh(event.runId)
  }), [refresh])

  useEffect(() => {
    const runId = currentRunId.current
    if (!runId || !isRunning(snapshot)) return
    const timer = window.setInterval(() => void refresh(runId), 1_500)
    return () => window.clearInterval(timer)
  }, [refresh, snapshot])

  useEffect(() => {
    setChoices({})
  }, [snapshot?.runId, identityReviewChoiceKey])

  useEffect(() => {
    if (!snapshot || snapshot.phase !== 'completed' || completionSeen.current === snapshot.runId) return
    completionSeen.current = snapshot.runId
    const outcome = snapshot.outcome
    toast.show(
      outcome
        ? `外部清单导入完成：写入 ${outcome.totalItems - outcome.skippedVideos} 部，跳过 ${outcome.skippedVideos} 部`
        : '外部清单导入完成',
      'success'
    )
    invalidateVideoLibraryQueries(queryClient)
    if (outcome) notifyPlaylistImportCompleted(outcome.playlistId)
  }, [queryClient, snapshot, toast])

  const open = useCallback((input?: PlaylistImportOpenInput): void => {
    if (snapshot && !['completed', 'cancelled', 'failed'].includes(snapshot.phase)) {
      setVisible(true)
      return
    }
    setVisible(true)
    setSourceUrl('')
    setRequestedName('')
    setTargetLibraryId('')
    setAutoCreateUnmatchedVideos(true)
    setSaveDetailLinks(true)
    setSaveSourcePlaylistLink(false)
    setDestinationKind(input?.destination?.kind ?? 'create')
    setPlaylistId(input?.destination?.kind === 'append' ? String(input.destination.playlistId) : '')
    setPlaylistLabel(input?.destination?.kind === 'append' ? input.destination.playlistName : '')
    setSnapshot(null)
    setChoices({})
    setBusy(true)
    setError(null)
    setCancelConfirmation(false)
    currentRunId.current = null
    completionSeen.current = null
    const generation=++optionsGeneration.current
    void api.mediaLibraries.list()
      .then((nextLibraries) => {
        if(generation!==optionsGeneration.current)return
        const activeLibraries = nextLibraries.filter((library) => library.status === 'active')
        setLibraries(activeLibraries)
        setTargetLibraryId(
          activeLibraries.find((library) => library.isDefault)?.id.toString() ?? ''
        )
      })
      .catch((loadError) => { if(generation===optionsGeneration.current)setError(loadError instanceof Error ? loadError.message : String(loadError)) })
      .finally(() => { if(generation===optionsGeneration.current)setBusy(false) })
  }, [snapshot])

  const start = async (): Promise<void> => {
    if (!sourceUrl.trim() || !targetLibraryId || (destinationKind === 'append' && !playlistId)) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.playlistImport.start({
        idempotencyKey: `renderer-playlist-import:${crypto.randomUUID()}`,
        sourceUrl: sourceUrl.trim(),
        targetLibraryId: Number(targetLibraryId),
        autoCreateUnmatchedVideos,
        saveDetailLinks,
        saveSourcePlaylistLink,
        destination: destinationKind === 'append'
          ? { kind: 'append', playlistId: Number(playlistId) }
          : { kind: 'create', ...(requestedName.trim() ? { requestedName: requestedName.trim() } : {}) }
      })
      currentRunId.current = next.runId
      setSnapshot(next)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!snapshot) {
      setCancelConfirmation(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const next = await api.playlistImport.control(snapshot.runId, {
        kind: 'cancel',
        idempotencyKey: `renderer-cancel:${crypto.randomUUID()}`
      })
      setSnapshot(next)
      currentRunId.current = null
      setVisible(false)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError))
    } finally {
      setCancelConfirmation(false)
      setBusy(false)
    }
  }

  const resolveIdentities = async (): Promise<void> => {
    if (!snapshot || snapshot.attention?.kind !== 'identity-review') return
    const items = snapshot.attention.items
    if (items.some((item) => !choices[item.itemId])) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.playlistImport.control(snapshot.runId, {
        kind: 'resolve-identities',
        expectedRevision: snapshot.revision,
        idempotencyKey: `renderer-identities:${crypto.randomUUID()}`,
        decisions: items.map((item) => ({ itemId: item.itemId, choice: choices[item.itemId] }))
      })
      setSnapshot(next)
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : String(resolveError))
    } finally {
      setBusy(false)
    }
  }

  const resumeBrowser = async (): Promise<void> => {
    if (!snapshot || snapshot.attention?.kind !== 'browser-handoff') return
    setBusy(true)
    setError(null)
    try {
      const next = await api.playlistImport.control(snapshot.runId, {
        kind: 'resume-browser',
        requestId: snapshot.attention.requestId,
        idempotencyKey: `renderer-browser-resume:${snapshot.attention.requestId}`
      })
      setSnapshot(next)
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError))
    } finally {
      setBusy(false)
    }
  }

  const retry = async (): Promise<void> => {
    if (!snapshot?.error?.retryable) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.playlistImport.control(snapshot.runId, {
        kind: 'retry',
        expectedRevision: snapshot.revision,
        idempotencyKey: `renderer-retry:${snapshot.runId}:${snapshot.revision}`
      })
      setSnapshot(next)
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError))
      await refresh(snapshot.runId)
    } finally {
      setBusy(false)
    }
  }

  const contextValue = useMemo(() => ({ open }), [open])
  const reviewItems = snapshot?.attention?.kind === 'identity-review'
    ? snapshot.attention.items
    : []
  const canStart = Boolean(
    sourceUrl.trim() && targetLibraryId && (destinationKind === 'create' || playlistId)
  )
  const terminationAction = snapshot && !['completed', 'cancelled', 'failed'].includes(snapshot.phase)
    ? (
        <Button disabled={busy} onClick={() => setCancelConfirmation(true)}>终止任务</Button>
      )
    : null

  return (
    <PlaylistImportContext.Provider value={contextValue}>
      {children}
      {visible ? (
        <AgentWorkspaceModal
          title="导入外部清单"
          hint="Agent 会在当前前台窗口完整读取清单；退出软件或终止任务后需要重新导入。"
          busy={busy}
          dismissible={false}
          onCancel={() => setVisible(false)}
          actions={snapshot ? (
            snapshot.attention?.kind === 'browser-handoff' ? (
              <>
                {terminationAction}
                <Button variant="primary" disabled={busy} onClick={() => void resumeBrowser()}>
                  我已完成，继续
                </Button>
              </>
            ) : snapshot.phase === 'waiting_user' && reviewItems.length > 0 ? (
              <>
                {terminationAction}
                <Button variant="primary" disabled={busy || reviewItems.some((item) => !choices[item.itemId])} onClick={() => void resolveIdentities()}>
                  应用身份选择
                </Button>
              </>
            ) : snapshot.phase === 'completed' ? (
              <>
                <Button onClick={() => setVisible(false)}>关闭</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setVisible(false)
                    navigate(`/playlists/${snapshot.outcome?.playlistId}`)
                  }}
                >
                  查看清单
                </Button>
              </>
            ) : snapshot.error?.retryable ? (
              <>
                {terminationAction}
                <Button variant="primary" disabled={busy} onClick={() => void retry()}>
                  重试
                </Button>
              </>
            ) : ['failed', 'cancelled'].includes(snapshot.phase) ? (
              <Button onClick={() => setVisible(false)}>关闭</Button>
            ) : (
              terminationAction
            )
          ) : (
            <>
              <Button disabled={busy} onClick={() => setVisible(false)}>取消</Button>
              <Button variant="primary" disabled={busy || !canStart} onClick={() => void start()}>开始导入</Button>
            </>
          )}
        >
          <AgentWorkspacePane label="Agent 运行">
              {snapshot ? (
                <AgentMetadataActivityFeed
                  key={snapshot.runId}
                  snapshot={{
                    phase: snapshot.phase,
                    summary: snapshot.summary,
                    activities: snapshot.activities ?? []
                  }}
                  live={isRunning(snapshot)}
                  statusLabel={phaseLabel(snapshot)}
                  statusHint={phaseHint(snapshot)}
                  handoffPrompt={snapshot.attention?.kind === 'browser-handoff'
                    ? snapshot.attention.prompt
                    : undefined}
                />
              ) : (
                <>
                  <AgentWorkspacePaneHeader
                    icon={<Bot {...UI_ICON_SM} aria-hidden />}
                    title="Agent 运行"
                    hint="配置来源和写入目标后开始读取。"
                    status="待开始"
                  />
                  <AgentWorkspacePaneBody variant="setup">
                    <div className={styles.setupIntro}>
                      <p className={styles.setupIntroText}>Agent 会逐页固化清单候选，再核对跨媒体库身份；所有写入在结果确定后一次完成。</p>
                    </div>
                    <div className={`entity-edit-form ${styles.setupForm}`}>
                      <EditFormSection title="来源与目标">
                        <div className="entity-edit-fields">
                          <EditFormField label="外部清单 URL" span={2} hint="必须是 HTTP/HTTPS 清单页；登录或验证码会暂停等待你处理。">
                            <input
                              className="text-input"
                              type="url"
                              inputMode="url"
                              value={sourceUrl}
                              onChange={(event) => setSourceUrl(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && canStart && !busy) void start()
                              }}
                              placeholder="https://example.com/list/..."
                              autoFocus
                            />
                          </EditFormField>
                          <EditFormField label="导入方式">
                            <SelectControl value={destinationKind} onChange={(event) => setDestinationKind(event.target.value as 'create' | 'append')}>
                              <option value="create">新建清单</option>
                              <option value="append">追加到清单</option>
                            </SelectControl>
                          </EditFormField>
                          {destinationKind === 'create' ? (
                            <EditFormField label="新清单名称" hint="可选。留空时由 Agent 从页面名称生成；未识别到时使用站点域名和日期。">
                              <input className="text-input" value={requestedName} onChange={(event) => setRequestedName(event.target.value)} />
                            </EditFormField>
                          ) : (
                            <EditFormField label="目标清单">
                              <PlaylistDestinationPicker value={playlistId} label={playlistLabel} disabled={busy}
                                onChange={(id,label)=>{setPlaylistId(id);setPlaylistLabel(label)}}/>
                            </EditFormField>
                          )}
                          <EditFormField label="目标媒体库" span={2} hint="只决定新影片写入位置及重复候选优先级；清单可以跨媒体库。">
                            <SelectControl value={targetLibraryId} onChange={(event) => setTargetLibraryId(event.target.value)}>
                              <option value="" disabled>请选择媒体库</option>
                              {libraries.map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
                            </SelectControl>
                          </EditFormField>
                        </div>
                      </EditFormSection>
                      <EditFormSection title="导入选项">
                        <div className={styles.setupOptions}>
                          <SettingsSwitchRow
                            title="自动创建无资源影片"
                            description="未匹配到已有影片时，在目标媒体库创建无资源影片；关闭后跳过这些条目。"
                            checked={autoCreateUnmatchedVideos}
                            onChange={setAutoCreateUnmatchedVideos}
                          />
                          <SettingsSwitchRow
                            title="保存详情页到相关链接"
                            description="将外部影片详情页保存到影片“相关链接”；已存在的链接不会重复添加。"
                            checked={saveDetailLinks}
                            onChange={setSaveDetailLinks}
                          />
                          <SettingsSwitchRow
                            title="保存来源清单链接"
                            description="开启后，将本次外部清单页保存到目标清单的“相关链接”；已存在的链接不会重复添加。"
                            checked={saveSourcePlaylistLink}
                            onChange={setSaveSourcePlaylistLink}
                          />
                        </div>
                      </EditFormSection>
                      <div className={styles.setupRule}>
                        不下载播放资源；被清单引用的无资源影片不会被自动清理。导入期间请保持软件和弹窗打开。
                      </div>
                    </div>
                  </AgentWorkspacePaneBody>
                </>
              )}
          </AgentWorkspacePane>

          <AgentWorkspacePane label="结果预览">
              <AgentWorkspacePaneHeader
                icon={<Database {...UI_ICON_SM} aria-hidden />}
                title="结果预览"
                hint={snapshot
                  ? `来源：${snapshot.frozenInput.sourceHost}`
                  : '发现的影片和匹配去向会持续显示在这里。'}
                hintTitle={snapshot?.frozenInput.displayUrl}
                status={snapshot ? `${snapshot.progress.uniqueItems} 部` : '等待结果'}
                ready={Boolean(snapshot?.preview?.items.length)}
              />

              <AgentWorkspacePaneBody variant="result">
                {error ? <div className={styles.error} role="alert">{error}</div> : null}
                {snapshot?.error ? <div className={styles.error} role="alert">{snapshot.error.message}</div> : null}

                {snapshot ? (
                  <div className={styles.preview}>
                    <section className={styles.metrics} aria-label="导入进度">
                      <div className={styles.metric}><strong className={styles.metricValue}>{snapshot.progress.pagesRead}</strong><span className={styles.metricLabel}>页面</span></div>
                      <div className={styles.metric}><strong className={styles.metricValue}>{snapshot.progress.uniqueItems}</strong><span className={styles.metricLabel}>去重影片</span></div>
                      <div className={styles.metric}><strong className={styles.metricValue}>{snapshot.outcome?.reusedVideos ?? snapshot.progress.directReuses}</strong><span className={styles.metricLabel}>复用已有</span></div>
                      <div className={styles.metric}><strong className={styles.metricValue}>{snapshot.outcome?.createdVideos ?? snapshot.progress.plannedCreates}</strong><span className={styles.metricLabel}>{snapshot.outcome ? '已新建' : '计划新建'}</span></div>
                    </section>

                    {reviewItems.length > 0 ? (
                      <PlaylistImportIdentityReview
                        items={reviewItems}
                        choices={choices}
                        onChange={(itemId, choice) => setChoices((current) => ({
                          ...current,
                          [itemId]: choice
                        }))}
                        onOpenExternalLink={openExternalLink}
                      />
                    ) : null}

                    {snapshot.preview?.items.length ? (
                      <section className={styles.previewSection} aria-label="影片结果">
                        <header className={styles.sectionHeader}>
                          <strong className={styles.sectionTitle}>影片结果</strong>
                          <span className={styles.sectionMeta}>{snapshot.preview.totalItems} 部</span>
                        </header>
                        <div className={styles.previewList}>
                          {snapshot.preview.items.map((item) => (
                            <div key={item.itemId} className={styles.previewRow}>
                              <span className={styles.previewPosition}>{item.sourcePosition + 1}</span>
                              <span className={styles.previewCopy}>
                                <span className={styles.previewTitleLine}>
                                  <strong className={styles.previewCode}>{item.code || `条目 #${item.itemId}`}</strong>
                                  {item.title ? <span className={styles.previewTitle} title={item.title}>{item.title}</span> : null}
                                </span>
                                <button className={styles.detailLink} type="button" onClick={() => openExternalLink(item.detailUrl)} title={item.detailUrl}>
                                  {item.resolvedVideo
                                    ? `→ ${item.resolvedVideo.code} · ${item.resolvedVideo.title || `影片 #${item.resolvedVideo.id}`}`
                                    : item.detailUrl}
                                  <ExternalLink size={10} aria-hidden />
                                </button>
                              </span>
                              <span className={styles.previewStatus} data-state={item.errorCode === 'AUTO_CREATE_DISABLED' ? 'skipped' : item.state}>
                                {previewStatus(item)}
                              </span>
                            </div>
                          ))}
                        </div>
                        {snapshot.preview.truncated ? (
                          <p className={styles.truncated}>当前显示前 {snapshot.preview.items.length} 部；完整清单仍会全部导入。</p>
                        ) : null}
                      </section>
                    ) : (
                      <EmptyState
                        variant="fill"
                        loading={isRunning(snapshot) || busy}
                        icon={<Database {...UI_ICON_SM} />}
                        title={snapshot.phase === 'failed' ? '本次导入没有生成结果' : '等待清单结果'}
                        description={snapshot.phase === 'failed'
                          ? '查看左侧最后一步和错误信息后重新发起导入。'
                          : 'Agent 固化第一批清单候选后，影片和匹配去向会显示在这里。'}
                      />
                    )}

                    {snapshot.outcome ? (
                      <section className={styles.outcome} aria-label="导入结果">
                        <strong className={styles.outcomeTitle}>导入完成</strong>
                        <span className={styles.outcomeDetails}>
                          <span className={styles.outcomeCopy}>
                            读取 {snapshot.outcome.pagesRead} 页、{snapshot.outcome.sourceItems} 条，唯一详情 {snapshot.outcome.uniqueDetailUrls} 个。
                          </span>
                          <span className={styles.outcomeCopy}>
                            直接复用 {snapshot.outcome.directReuses}，详情消歧 {snapshot.outcome.detailReuses}，
                            人工选择 {snapshot.outcome.userSelectedReuses}，新建 {snapshot.outcome.createdVideos}，跳过 {snapshot.outcome.skippedVideos}。
                          </span>
                          <span className={styles.outcomeCopy}>
                            加入清单 {snapshot.outcome.addedToPlaylist}，原已在清单 {snapshot.outcome.alreadyInPlaylist}，
                            跨库复用 {snapshot.outcome.crossLibraryReuses}，目标库新成员 {snapshot.outcome.targetLibraryMembersCreated}，
                            影片链接 {snapshot.outcome.relatedLinksAdded}，清单链接 {snapshot.outcome.playlistRelatedLinksAdded}。
                          </span>
                          <span className={styles.outcomeCopy}>
                            外部重复 {snapshot.outcome.externalDuplicateItems}，归并到同一影片 {snapshot.outcome.convergedExternalItems}；
                            清单“{snapshot.outcome.playlistName}”，目标媒体库“{snapshot.outcome.targetLibraryName}”。
                          </span>
                          {snapshot.outcome.reuseLibraryDistribution.length > 0 ? (
                            <span className={styles.outcomeCopy}>
                              复用影片分布：{snapshot.outcome.reuseLibraryDistribution.map((entry) => (
                                `${entry.libraryName} ${entry.reusedVideos}`
                              )).join('，')}。
                            </span>
                          ) : null}
                        </span>
                      </section>
                    ) : null}
                  </div>
                ) : (
                  <EmptyState
                    variant="fill"
                    loading={busy}
                    icon={<Database {...UI_ICON_SM} />}
                    title="等待导入结果"
                    description="开始后，发现的影片、跨库匹配和新建计划会实时显示在这里。"
                  />
                )}
              </AgentWorkspacePaneBody>
          </AgentWorkspacePane>
        </AgentWorkspaceModal>
      ) : null}
      {cancelConfirmation ? (
        <ConfirmModal
          title="终止外部清单导入？"
          confirmText="终止任务"
          danger
          busy={busy}
          dismissible={!busy}
          onCancel={() => setCancelConfirmation(false)}
          onConfirm={() => void cancel()}
        >
          <p>
            当前 Agent、浏览器会话和未完成的导入会立即停止；暂存结果不会写入清单或影片，任务终止后无法继续。
          </p>
        </ConfirmModal>
      ) : null}
    </PlaylistImportContext.Provider>
  )
}
