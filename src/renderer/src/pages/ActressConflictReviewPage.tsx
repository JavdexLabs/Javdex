import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, CircleAlert, Trash2, UserRoundCheck, UsersRound } from 'lucide-react'
import type {
  ActressNameConflictGroup,
  ActressPendingNameType,
  ActressListItem,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  PendingActressScrapeCandidate,
  ResolveActressConflictInput
} from '@shared/types'
import { ACTRESS_SCRAPE_FIELD_OPTIONS } from '@shared/types'
import { api, resolveMediaSrc } from '../api'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import ActressAvatar from '../components/ActressAvatar'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useToast } from '../components/Toast'
import { navigateToActressList } from '../listView/listNavigation'
import { actressKeys } from '../query/queryKeys'
import { useDebounce } from '../hooks/useDebounce'
import {
  buildActressConflictDecisionSnapshot,
  canConfirmIllegalName,
  conflictClaimantsNeedingReplacement,
  type ActressOwnershipDecision,
  type IllegalNameReplacementValidationStatus
} from './actressConflictReviewState'

const FIELD_LABEL = new Map(ACTRESS_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label]))

const MODE_LABEL: Record<ActressScrapeUpdateMode, string> = {
  replace: '覆盖更新',
  fillEmpty: '空字段补齐',
  replaceIfPresent: '有值覆盖'
}

const NAME_TYPE_LABEL: Record<ActressPendingNameType, string> = {
  main: '主名',
  zh: '中文名',
  en: '英文名',
  alias: '别名'
}

const RESULT_LABELS: Array<{
  key: keyof PendingActressScrapeCandidate['result']
  label: string
}> = [
  { key: 'mainName', label: '返回主名' },
  { key: 'nameZh', label: '中文名' },
  { key: 'nameEn', label: '英文名' },
  { key: 'birthDate', label: '生日' },
  { key: 'debutDate', label: '出道日期' },
  { key: 'heightCm', label: '身高' },
  { key: 'bustCm', label: '胸围' },
  { key: 'waistCm', label: '腰围' },
  { key: 'hipCm', label: '臀围' },
  { key: 'cupSize', label: '罩杯' },
  { key: 'bloodType', label: '血型' },
  { key: 'zodiac', label: '星座' },
  { key: 'nationality', label: '国籍' },
  { key: 'profileSummary', label: '简介' },
  { key: 'aliases', label: '别名' }
]

function formatValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : null
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value.trim() || null
  return null
}

function candidateFieldLabel(fields: ActressScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、')
}

function CandidateButton({
  candidate,
  selected,
  onSelect
}: {
  candidate: PendingActressScrapeCandidate
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`conflict-review-actor${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <ActressAvatar
        src={resolveMediaSrc(candidate.actressAvatarPath)}
        name={candidate.actressMainName}
        gender={null}
      />
      <span>
        <strong>{candidate.actressMainName}</strong>
        <small>待确认结果 · {candidate.plugin.name}</small>
        <em>{MODE_LABEL[candidate.mode]} · {candidateFieldLabel(candidate.selectedFields)}</em>
      </span>
    </button>
  )
}

export default function ActressConflictReviewPage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedPendingId, setSelectedPendingId] = useState<number | null>(null)
  const [discardCandidate, setDiscardCandidate] = useState<PendingActressScrapeCandidate | null>(
    null
  )
  const [discarding, setDiscarding] = useState(false)
  const [selectedConflictKey, setSelectedConflictKey] = useState<string | null>(null)
  const [editedName, setEditedName] = useState('')
  const [resolving, setResolving] = useState(false)
  const [ownershipDecision, setOwnershipDecision] =
    useState<ActressOwnershipDecision | null>(null)
  const [replacementMainNames, setReplacementMainNames] = useState<Record<number, string>>({})
  const [existingOwnerSearch, setExistingOwnerSearch] = useState('')
  const [existingOwnerOptions, setExistingOwnerOptions] = useState<ActressListItem[]>([])
  const [existingOwnersLoading, setExistingOwnersLoading] = useState(false)
  const [selectedExistingOwner, setSelectedExistingOwner] = useState<{
    actressId: number
    mainName: string
    revision: number
  } | null>(null)
  const [illegalNameOpen, setIllegalNameOpen] = useState(false)
  const [illegalValidationStatus, setIllegalValidationStatus] =
    useState<IllegalNameReplacementValidationStatus>('idle')
  const [illegalValidationErrors, setIllegalValidationErrors] = useState<Record<number, string>>({})
  const illegalValidationSeqRef = useRef(0)
  const resetIllegalNameDialog = useCallback((): void => {
    setIllegalNameOpen(false)
    setReplacementMainNames({})
    setIllegalValidationStatus('idle')
    setIllegalValidationErrors({})
  }, [])
  const debouncedExistingOwnerSearch = useDebounce(existingOwnerSearch, 250)

  const groupsQuery = useQuery({
    queryKey: actressKeys.conflicts(),
    queryFn: () => api.actressScrape.listConflicts()
  })
  const groups = groupsQuery.data ?? []
  const pendingCount = new Set(
    groups.flatMap((group) => group.candidates.map((candidate) => candidate.pendingId))
  ).size
  const selectedGroup =
    groups.find((group) => group.normalizedName === selectedName) ?? groups[0] ?? null
  const selectedCandidate =
    selectedGroup?.candidates.find((candidate) => candidate.pendingId === selectedPendingId) ??
    selectedGroup?.candidates[0] ??
    null
  const selectedConflicts =
    selectedCandidate?.conflicts.filter(
      (conflict) => conflict.normalizedName === selectedGroup?.normalizedName
    ) ?? []
  const selectedConflict =
    selectedConflicts.find(
      (conflict) => `${conflict.type}\0${conflict.name}` === selectedConflictKey
    ) ?? selectedConflicts[0] ?? null
  const illegalReplacementClaimants = useMemo(
    () => (selectedGroup ? conflictClaimantsNeedingReplacement(selectedGroup, null) : []),
    [selectedGroup]
  )
  const illegalReplacements = useMemo(
    () =>
      illegalReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNames[claimant.actressId] ?? ''
      })),
    [illegalReplacementClaimants, replacementMainNames]
  )
  const debouncedIllegalReplacements = useDebounce(illegalReplacements, 250)

  useEffect(() => {
    if (!selectedGroup) {
      setSelectedName(null)
      setSelectedPendingId(null)
      return
    }
    if (selectedName !== selectedGroup.normalizedName) {
      setSelectedName(selectedGroup.normalizedName)
    }
    if (selectedCandidate && selectedPendingId !== selectedCandidate.pendingId) {
      setSelectedPendingId(selectedCandidate.pendingId)
    }
  }, [selectedCandidate, selectedGroup, selectedName, selectedPendingId])

  useEffect(() => {
    const key = selectedConflict ? `${selectedConflict.type}\0${selectedConflict.name}` : null
    if (selectedConflictKey !== key) setSelectedConflictKey(key)
    setEditedName(selectedConflict?.name ?? '')
  }, [
    selectedCandidate?.pendingId,
    selectedConflict?.name,
    selectedConflict?.type,
    selectedConflictKey,
    selectedGroup?.normalizedName
  ])

  useEffect(() => {
    if (ownershipDecision !== 'assignToExistingActress') return
    let cancelled = false
    setExistingOwnersLoading(true)
    api.actresses
      .list(debouncedExistingOwnerSearch.trim(), 'all')
      .then((items) => {
        if (!cancelled) setExistingOwnerOptions(items.slice(0, 40))
      })
      .catch((error) => {
        if (!cancelled) toast.show(String((error as Error).message), 'error')
      })
      .finally(() => {
        if (!cancelled) setExistingOwnersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedExistingOwnerSearch, ownershipDecision, toast])

  useEffect(() => {
    illegalValidationSeqRef.current += 1
    setIllegalValidationErrors({})
    if (!illegalNameOpen) {
      setIllegalValidationStatus('idle')
    } else if (illegalReplacementClaimants.length === 0) {
      setIllegalValidationStatus('valid')
    } else if (
      illegalReplacementClaimants.some(
        (claimant) => !replacementMainNames[claimant.actressId]?.trim()
      )
    ) {
      setIllegalValidationStatus('idle')
    } else {
      setIllegalValidationStatus('checking')
    }
  }, [illegalNameOpen, illegalReplacements, selectedGroup])

  useEffect(() => {
    if (!illegalNameOpen || !selectedGroup || illegalReplacementClaimants.length === 0) return
    if (debouncedIllegalReplacements.some((replacement) => !replacement.mainName.trim())) return
    const seq = illegalValidationSeqRef.current
    const snapshot = buildActressConflictDecisionSnapshot(selectedGroup)
    void api.actressScrape
      .validateIllegalNameReplacements({
        snapshot,
        replacementMainNames: debouncedIllegalReplacements
      })
      .then((result) => {
        if (seq !== illegalValidationSeqRef.current) return
        if (result.status === 'valid') {
          setIllegalValidationStatus('valid')
          setIllegalValidationErrors({})
          return
        }
        if (result.status === 'invalid') {
          setIllegalValidationStatus('invalid')
          setIllegalValidationErrors(
            Object.fromEntries(result.errors.map((error) => [error.actressId, error.message]))
          )
          return
        }
        setIllegalValidationStatus('stale')
        resetIllegalNameDialog()
        toast.show(result.message, 'info')
        void queryClient.invalidateQueries({ queryKey: actressKeys.conflicts() })
      })
      .catch((error) => {
        if (seq !== illegalValidationSeqRef.current) return
        setIllegalValidationStatus('invalid')
        toast.show(String((error as Error).message), 'error')
      })
  }, [
    debouncedIllegalReplacements,
    illegalNameOpen,
    illegalReplacementClaimants.length,
    queryClient,
    resetIllegalNameDialog,
    selectedGroup,
    toast
  ])

  const resultFields = useMemo(
    () =>
      selectedCandidate
        ? RESULT_LABELS.flatMap(({ key, label }) => {
            const value = formatValue(selectedCandidate.result[key])
            return value ? [{ key, label, value }] : []
          })
        : [],
    [selectedCandidate]
  )
  const previewResources = selectedCandidate?.resources ?? []

  const discard = async (): Promise<void> => {
    if (!discardCandidate || discarding) return
    setDiscarding(true)
    try {
      await api.actressScrape.discardConflict({
        pendingId: discardCandidate.pendingId,
        expectedRevision: discardCandidate.revision
      })
      setDiscardCandidate(null)
      setSelectedPendingId(null)
      await queryClient.invalidateQueries({ queryKey: actressKeys.all })
      await groupsQuery.refetch()
      toast.show('已丢弃错误匹配并清理暂存资源', 'success')
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
      await groupsQuery.refetch()
    } finally {
      setDiscarding(false)
    }
  }


  const resolveDecision = async (input: ResolveActressConflictInput): Promise<void> => {
    if (resolving) return
    setResolving(true)
    try {
      const outcome = await api.actressScrape.resolveConflict(input)
      if (outcome.status === 'stale') {
        toast.show(outcome.message, 'info')
      } else {
        toast.show('名称冲突已处理', 'success')
        setSelectedPendingId(null)
      }
      setOwnershipDecision(null)
      resetIllegalNameDialog()
      setExistingOwnerSearch('')
      setSelectedExistingOwner(null)
      await queryClient.invalidateQueries({ queryKey: actressKeys.all })
      await groupsQuery.refetch()
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
      await groupsQuery.refetch()
    } finally {
      setResolving(false)
    }
  }

  const editSelectedName = (): void => {
    if (!selectedGroup || !selectedCandidate || !selectedConflict) return
    void resolveDecision({
      kind: 'editName',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      pendingId: selectedCandidate.pendingId,
      name: selectedConflict.name,
      nameType: selectedConflict.type,
      newName: editedName,
      replacementMainNames: []
    })
  }

  const applySelectedPending = (): void => {
    if (!selectedGroup || !selectedCandidate) return
    void resolveDecision({
      kind: 'applyPending',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      pendingId: selectedCandidate.pendingId,
      replacementMainNames: []
    })
  }

  const confirmOwnershipDecision = (): void => {
    if (!selectedGroup || !selectedCandidate || !ownershipDecision) return
    const chosenOwnerActressId = selectedExistingOwner?.actressId ?? null
    const destinationOwnerActressId =
      ownershipDecision === 'assignToCurrentActress'
        ? selectedCandidate.actressId
        : chosenOwnerActressId
    const replacements = conflictClaimantsNeedingReplacement(
      selectedGroup,
      destinationOwnerActressId
    ).map((claimant) => ({
      actressId: claimant.actressId,
      mainName: replacementMainNames[claimant.actressId] ?? ''
    }))
    if (ownershipDecision === 'assignToCurrentActress') {
      void resolveDecision({
        kind: ownershipDecision,
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        pendingId: selectedCandidate.pendingId,
        replacementMainNames: replacements
      })
      return
    }
    if (!selectedExistingOwner) return
    void resolveDecision({
      kind: ownershipDecision,
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      ownerActressId: selectedExistingOwner.actressId,
      ownerActressRevision: selectedExistingOwner.revision,
      replacementMainNames: replacements
    })
  }

  const confirmIllegalName = (): void => {
    if (!selectedGroup) return
    void resolveDecision({
      kind: 'markIllegalName',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      replacementMainNames: illegalReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNames[claimant.actressId] ?? ''
      }))
    })
  }

  const selectExistingOwner = async (item: ActressListItem): Promise<void> => {
    try {
      const detail = item.revision == null ? await api.actresses.get(item.id) : null
      const revision = item.revision ?? detail?.revision
      if (revision == null) throw new Error('无法读取演员当前版本，请刷新后重试')
      setSelectedExistingOwner({
        actressId: item.id,
        mainName: item.main_name,
        revision
      })
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const decisionDestinationActressId =
    ownershipDecision === 'assignToCurrentActress'
      ? selectedCandidate?.actressId
      : selectedExistingOwner?.actressId
  const replacementClaimants = selectedGroup
    ? conflictClaimantsNeedingReplacement(selectedGroup, decisionDestinationActressId)
    : []

  return (
    <div className="detail-pane conflict-review-page">
      <header className="conflict-review-header">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => navigateToActressList(navigate, location)}
        >
          <ArrowLeft {...UI_ICON_SM} aria-hidden />
          返回演员
        </button>
        <div>
          <span>演员维护</span>
          <h1>名称冲突待确认</h1>
          <p>刮削结果在确认前不会写入演员资料。</p>
        </div>
        <strong aria-live="polite">待确认 {pendingCount}</strong>
      </header>

      {groupsQuery.isLoading ? (
        <EmptyState loading variant="page" />
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<UserRoundCheck {...UI_ICON_SM} aria-hidden />}
          title="没有待确认的名称冲突"
          description="所有演员刮削结果都已处理。"
          variant="page"
        />
      ) : (
        <div className="conflict-review-workspace">
          <aside className="conflict-review-groups" aria-label="名称冲突组">
            <div className="conflict-review-pane-title">
              <strong>冲突名称</strong>
              <span>按标准化名称聚合</span>
            </div>
            <div className="conflict-review-group-list">
              {groups.map((group) => (
                <button
                  type="button"
                  key={group.normalizedName}
                  className={
                    group.normalizedName === selectedGroup?.normalizedName ? 'is-selected' : ''
                  }
                  onClick={() => {
                    setSelectedName(group.normalizedName)
                    setSelectedPendingId(group.candidates[0]?.pendingId ?? null)
                  }}
                >
                  <span>
                    <strong>{group.displayName}</strong>
                    <small>
                      {group.status === 'applicable'
                        ? '冲突已消失 · 等待应用'
                        : group.currentOwner
                          ? `当前归属 · ${group.currentOwner.mainName}`
                          : group.claimants.length > 0
                            ? `历史归属待确认 · ${group.claimants.length} 位`
                            : '当前无归属'}
                    </small>
                  </span>
                  <em>{group.candidates.length}</em>
                </button>
              ))}
            </div>
          </aside>

          {selectedGroup && selectedCandidate ? (
            <main className="scroll-body scroll-body--scroll conflict-review-detail">
              <header className="conflict-review-detail-head">
                <div>
                  <span>标准化名称冲突</span>
                  <h2>{selectedGroup.displayName}</h2>
                  <p>标准化键：{selectedGroup.normalizedName}</p>
                </div>
                  <span className="conflict-review-state">
                  {selectedGroup.status === 'applicable' ? (
                    <UserRoundCheck {...UI_ICON_SM} aria-hidden />
                  ) : (
                    <CircleAlert {...UI_ICON_SM} aria-hidden />
                  )}
                  {selectedGroup.status === 'applicable' ? '可应用' : '待确认'}
                </span>
              </header>

              <section className="conflict-review-section">
                <div className="conflict-review-section-title">
                  <strong>当前归属与候选结果</strong>
                  <span>选择一份候选查看刮削详情</span>
                </div>
                <div className="conflict-review-actors">
                  {selectedGroup.claimants.map((claimant) => {
                    const isCurrentOwner =
                      claimant.actressId === selectedGroup.currentOwner?.actressId
                    return (
                    <div
                      className={`conflict-review-owner ${isCurrentOwner ? 'is-current' : 'is-legacy'}`}
                      key={claimant.actressId}
                    >
                      <ActressAvatar
                        src={resolveMediaSrc(claimant.avatarPath)}
                        name={claimant.mainName}
                        gender={null}
                      />
                      <span>
                        <strong>{claimant.mainName}</strong>
                        <small>
                          {isCurrentOwner ? '当前归属' : '历史归属待确认'} ·{' '}
                          {claimant.nameTypes.map((type) => NAME_TYPE_LABEL[type]).join(' / ')}
                        </small>
                      </span>
                      {isCurrentOwner ? (
                        <UserRoundCheck {...UI_ICON_SM} aria-hidden />
                      ) : (
                        <CircleAlert {...UI_ICON_SM} aria-hidden />
                      )}
                    </div>
                    )
                  })}
                  {selectedGroup.candidates.map((candidate) => (
                    <CandidateButton
                      key={candidate.pendingId}
                      candidate={candidate}
                      selected={candidate.pendingId === selectedCandidate.pendingId}
                      onSelect={() => setSelectedPendingId(candidate.pendingId)}
                    />
                  ))}
                </div>
              </section>

              <section className="conflict-review-section conflict-review-candidate">
                <div className="conflict-review-section-title">
                  <strong>候选资料 · {selectedCandidate.actressMainName}</strong>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost conflict-review-discard"
                    onClick={() => setDiscardCandidate(selectedCandidate)}
                  >
                    <Trash2 {...UI_ICON_SM} aria-hidden />丢弃错误匹配
                  </button>
                </div>
                <dl className="conflict-review-meta">
                  <div><dt>插件来源</dt><dd>{selectedCandidate.plugin.name} · {selectedCandidate.plugin.source}</dd></div>
                  <div><dt>查询名称</dt><dd>{selectedCandidate.queryName}</dd></div>
                  <div><dt>更新方式</dt><dd>{MODE_LABEL[selectedCandidate.mode]}</dd></div>
                  <div><dt>选择字段</dt><dd>{candidateFieldLabel(selectedCandidate.selectedFields)}</dd></div>
                </dl>
                <div className="conflict-review-actions" aria-label="名称冲突处理">
                  {selectedGroup.status === 'applicable' ? (
                    <div className="conflict-review-apply-ready">
                      <span>名称冲突已在其他操作中消失，资料仍未写入。</span>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={resolving}
                        onClick={applySelectedPending}
                      >
                        应用待确认资料
                      </button>
                    </div>
                  ) : selectedConflict ? (
                    <>
                      <div className="conflict-review-edit-name">
                        {selectedConflicts.length > 1 ? (
                          <label>
                            <span>名称项</span>
                            <select
                              className="text-input"
                              value={`${selectedConflict.type}\0${selectedConflict.name}`}
                              onChange={(event) => setSelectedConflictKey(event.target.value)}
                              disabled={resolving}
                            >
                              {selectedConflicts.map((conflict) => (
                                <option
                                  key={`${conflict.type}\0${conflict.name}`}
                                  value={`${conflict.type}\0${conflict.name}`}
                                >
                                  {NAME_TYPE_LABEL[conflict.type]} · {conflict.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        <label>
                          <span>修改所选{NAME_TYPE_LABEL[selectedConflict.type]}</span>
                          <input
                            className="text-input"
                            value={editedName}
                            onChange={(event) => setEditedName(event.target.value)}
                            disabled={resolving}
                          />
                        </label>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={resolving || !editedName.trim()}
                          onClick={editSelectedName}
                        >
                          修改名称
                        </button>
                      </div>
                      <div className="conflict-review-ownership-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={resolving}
                          onClick={() => setOwnershipDecision('assignToCurrentActress')}
                        >
                          归给 {selectedCandidate.actressMainName}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={resolving}
                          onClick={() => {
                            if (selectedGroup.currentOwner) {
                              setSelectedExistingOwner({
                                actressId: selectedGroup.currentOwner.actressId,
                                mainName: selectedGroup.currentOwner.mainName,
                                revision: selectedGroup.currentOwner.revision
                              })
                            } else {
                              setSelectedExistingOwner(null)
                            }
                            setOwnershipDecision('assignToExistingActress')
                          }}
                        >
                          归给已有演员…
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost conflict-review-illegal"
                          disabled={resolving}
                          onClick={() => {
                            setOwnershipDecision(null)
                            resetIllegalNameDialog()
                            setIllegalNameOpen(true)
                          }}
                        >
                          <Ban {...UI_ICON_SM} aria-hidden />
                          标记为非法名称
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
                {resultFields.length > 0 ? (
                  <dl className="conflict-review-values">
                    {resultFields.map((field) => (
                      <div key={field.key}><dt>{field.label}</dt><dd>{field.value}</dd></div>
                    ))}
                  </dl>
                ) : null}
                {previewResources.length > 0 ? (
                  <div className="conflict-review-previews">
                    {previewResources.slice(0, 6).map((resource) => (
                      <img
                        key={`${resource.field}-${resource.position}`}
                        src={resolveMediaSrc(resource.stagedPath) ?? undefined}
                        alt={resource.field === 'avatar' ? '待确认头像' : '待确认写真'}
                        draggable={false}
                      />
                    ))}
                  </div>
                ) : null}
                {selectedCandidate.warnings.length > 0 ? (
                  <div className="conflict-review-warnings" role="status">
                    {selectedCandidate.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                ) : null}
              </section>
            </main>
          ) : (
            <EmptyState icon={<UsersRound {...UI_ICON_SM} />} title="请选择冲突组" variant="fill" />
          )}
        </div>
      )}

      {ownershipDecision && selectedGroup && selectedCandidate ? (
        <ConfirmModal
          title={
            ownershipDecision === 'assignToCurrentActress'
              ? `将名称归给「${selectedCandidate.actressMainName}」`
              : `将名称归给「${selectedExistingOwner?.mainName ?? '已有演员'}」`
          }
          confirmText={resolving ? '处理中…' : '确认归属'}
          confirmDisabled={
            resolving ||
            (ownershipDecision === 'assignToExistingActress' && !selectedExistingOwner) ||
            replacementClaimants.some(
              (claimant) => !replacementMainNames[claimant.actressId]?.trim()
            )
          }
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={confirmOwnershipDecision}
          onCancel={() => {
            setOwnershipDecision(null)
            setReplacementMainNames({})
            setExistingOwnerSearch('')
            setSelectedExistingOwner(null)
          }}
        >
          <p>
            {ownershipDecision === 'assignToCurrentActress'
              ? `「${selectedGroup.displayName}」的完整归属会转给所选待确认演员；原归属演员的同名名称行会被移除。`
              : '整个同名组会确认给所选演员；各份非名称资料仍写回自己的原目标演员。'}
          </p>
          {ownershipDecision === 'assignToExistingActress' ? (
            <div className="conflict-review-existing-owner-picker">
              <input
                type="search"
                className="search-input"
                placeholder="搜索主名或别名…"
                value={existingOwnerSearch}
                onChange={(event) => setExistingOwnerSearch(event.target.value)}
                disabled={resolving}
              />
              <div className="conflict-review-existing-owner-list" role="listbox" aria-label="已有演员">
                {existingOwnersLoading ? (
                  <EmptyState loading variant="modal" />
                ) : existingOwnerOptions.length === 0 ? (
                  <EmptyState title="没有匹配的演员" variant="modal" />
                ) : existingOwnerOptions.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selectedExistingOwner?.actressId === item.id}
                    className={selectedExistingOwner?.actressId === item.id ? 'is-selected' : ''}
                    onClick={() => void selectExistingOwner(item)}
                  >
                    <ActressAvatar
                      src={resolveMediaSrc(item.avatar_path)}
                      name={item.main_name}
                      gender={item.gender}
                      decorative
                    />
                    <span><strong>{item.main_name}</strong><small>{item.video_count} 部影片</small></span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {replacementClaimants.map((claimant, index) => (
            <label className="conflict-review-replacement-main" key={claimant.actressId}>
              <span>为「{claimant.mainName}」填写替代主名</span>
              <input
                autoFocus={index === 0}
                className="text-input form-control-full"
                value={replacementMainNames[claimant.actressId] ?? ''}
                onChange={(event) =>
                  setReplacementMainNames((current) => ({
                    ...current,
                    [claimant.actressId]: event.target.value
                  }))
                }
                disabled={resolving}
              />
            </label>
          ))}
        </ConfirmModal>
      ) : null}

      {illegalNameOpen && selectedGroup ? (
        <ConfirmModal
          title={`删除非法名称「${selectedGroup.displayName}」`}
          size="sm"
          danger
          confirmText={resolving ? '处理中…' : '确认删除名称'}
          confirmDisabled={
            resolving ||
            !canConfirmIllegalName(
              illegalReplacementClaimants,
              replacementMainNames,
              illegalValidationStatus
            )
          }
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={confirmIllegalName}
          onCancel={resetIllegalNameDialog}
        >
          <div>
            <p>
              这会删除该名称的当前归属、所有相关名称声明，以及整个聚合组中的冲突项。被解除的待确认资料会继续应用到各自演员。
            </p>
            <p>
              此操作不会保存黑名单或长期规则；未来插件再次返回相同文本时，仍会按普通名称冲突处理。
            </p>
          </div>
          {illegalReplacementClaimants.map((claimant, index) => {
            const error = illegalValidationErrors[claimant.actressId]
            return (
              <label className="conflict-review-replacement-main" key={claimant.actressId}>
                <span>为「{claimant.mainName}」填写替代主名</span>
                <input
                  autoFocus={index === 0}
                  className="text-input form-control-full"
                  value={replacementMainNames[claimant.actressId] ?? ''}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? `illegal-name-error-${claimant.actressId}` : undefined}
                  onChange={(event) =>
                    setReplacementMainNames((current) => ({
                      ...current,
                      [claimant.actressId]: event.target.value
                    }))
                  }
                  disabled={resolving}
                />
                {error ? (
                  <small
                    id={`illegal-name-error-${claimant.actressId}`}
                    className="text-danger"
                  >
                    {error}
                  </small>
                ) : null}
              </label>
            )
          })}
          {illegalReplacementClaimants.length > 0 && illegalValidationStatus === 'checking' ? (
            <p className="modal-lead" role="status">
              正在检查替代主名…
            </p>
          ) : null}
        </ConfirmModal>
      ) : null}

      {discardCandidate ? (
        <ConfirmModal
          title="丢弃错误匹配"
          danger
          confirmText={discarding ? '丢弃中…' : '确认丢弃'}
          busy={discarding}
          closeDisabled={discarding}
          onConfirm={() => void discard()}
          onCancel={() => setDiscardCandidate(null)}
        >
          <p>
            确认丢弃「{discardCandidate.actressMainName}」的这份刮削结果吗？其他同名冲突结果和当前名称归属不会改变。
          </p>
        </ConfirmModal>
      ) : null}
    </div>
  )
}
