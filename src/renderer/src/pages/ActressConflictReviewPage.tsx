import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Ban,
  CircleAlert,
  GitMerge,
  Pencil,
  Trash2,
  UserRoundCheck,
  UserRoundSearch,
  UsersRound
} from 'lucide-react'
import type {
  ActressListItem,
  ActressNameConflictGroup,
  ActressPendingNameType,
  ActressScrapeField,
  ActressScrapeFieldImpact,
  ActressScrapeUpdateMode,
  PendingActressNameClaim,
  PendingActressScrapeCandidate,
  ResolveActressConflictInput
} from '@shared/types'
import { ACTRESS_SCRAPE_FIELD_OPTIONS } from '@shared/types'
import { api, resolveMediaSrc } from '../api'
import ActressAvatar from '../components/ActressAvatar'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useToast } from '../components/Toast'
import {
  WorkbenchMain,
  WorkbenchRail,
  WorkbenchRailHeader,
  WorkbenchShell,
  WorkbenchStatusPill,
  WorkbenchTabs,
  WorkbenchToolbar
} from '../components/workbench'
import { useDebounce } from '../hooks/useDebounce'
import { navigateToActressList } from '../listView/listNavigation'
import { actressKeys } from '../query/queryKeys'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import ConflictMergeActressesModal, {
  type ConflictMergeActressesDecision
} from './ConflictMergeActressesModal'
import {
  buildActressConflictDecisionSnapshot,
  buildActressConflictMergeActors,
  buildConflictQueueSections,
  buildConflictReviewRefreshState,
  canConfirmIllegalName,
  CONFLICT_ACTION_SCOPE_LABEL,
  conflictClaimantsNeedingReplacement,
  conflictFieldImpactsForProposedOwner,
  createConflictReviewSelection,
  inspectConflictNameEdit,
  partitionConflictFieldImpacts,
  selectConflictProposedOwner,
  selectConflictSource,
  type ConflictReviewProposedOwner,
  type ConflictReviewSelection,
  type IllegalNameReplacementValidationStatus
} from './actressConflictReviewState'

const FIELD_LABEL = new Map(
  ACTRESS_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label])
)

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

const IMPACT_PART_LABEL: Record<NonNullable<ActressScrapeFieldImpact['part']>, string> = {
  bustCm: '胸围',
  waistCm: '腰围',
  hipCm: '臀围'
}

const IMPACT_ACTION_LABEL: Record<ActressScrapeFieldImpact['action'], string> = {
  set: '写入',
  clear: '将清空',
  append: '追加',
  replace: '替换',
  preserve: '保持不变'
}

const IMPACT_PRESERVE_REASON_LABEL: Record<ActressScrapeFieldImpact['reason'], string> = {
  replace: '新旧值相同',
  fillEmpty: '空字段补齐未改变此值',
  replaceIfPresent: '有值覆盖未改变此值',
  noValue: '插件未返回值',
  existingValue: '已有值，按更新方式保留',
  resourceUnavailable: '暂存资源不可用'
}

const RESULT_FIELDS: Array<{
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
  { key: 'aliases', label: '别名' },
  { key: 'sourceUrl', label: '资料页' }
]

interface ConflictOwnerOption extends ConflictReviewProposedOwner {
  avatarPath: string | null
  roles: string[]
}

function formatValue(value: unknown): string | null {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : null
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value.trim() || null
  return null
}

function formatImpactValue(value: ActressScrapeFieldImpact['currentValue']): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join('、') : '空'
  if (value === null || value === '') return '空'
  return String(value)
}

function candidateFieldLabel(fields: ActressScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、') || '仅名称'
}

function buildOwnerOptions(group: ActressNameConflictGroup): ConflictOwnerOption[] {
  const options = new Map<number, ConflictOwnerOption>()
  const ensure = (
    actressId: number,
    revision: number,
    mainName: string,
    avatarPath: string | null,
    role: string
  ): void => {
    const current = options.get(actressId)
    if (current) {
      if (!current.roles.includes(role)) current.roles.push(role)
      return
    }
    options.set(actressId, { actressId, revision, mainName, avatarPath, roles: [role] })
  }
  for (const claimant of group.claimants) {
    ensure(
      claimant.actressId,
      claimant.revision,
      claimant.mainName,
      claimant.avatarPath,
      group.currentOwner?.actressId === claimant.actressId ? '当前归属' : '历史名称声明'
    )
  }
  for (const candidate of group.candidates) {
    ensure(
      candidate.actressId,
      candidate.actressRevision,
      candidate.actressMainName,
      candidate.actressAvatarPath,
      '本次刮削目标'
    )
  }
  return [...options.values()].sort((left, right) =>
    left.mainName.localeCompare(right.mainName, 'zh-Hans-CN')
  )
}

function ImpactRows({
  candidate,
  impacts
}: {
  candidate: PendingActressScrapeCandidate
  impacts: ActressScrapeFieldImpact[]
}): JSX.Element {
  if (!candidate.willApplyAfterDecision) {
    return (
      <p className="conflict-workbench-impact-note">
        处理本组后仍有 {candidate.remainingConflictCountAfterDecision} 个名称冲突，资料暂不写入。
      </p>
    )
  }
  const { changed, unchanged, unchangedInitiallyOpen } = partitionConflictFieldImpacts(impacts)
  return (
    <div className="conflict-workbench-impact-list">
      {changed.length === 0 ? (
        <p className="conflict-workbench-impact-note">没有资料字段会发生变化。</p>
      ) : (
        changed.map((impact, index) => (
          <div
            className={`conflict-workbench-impact-row is-${impact.action}`}
            key={`${impact.field}-${impact.part ?? 'field'}-${index}`}
          >
            <span>
              {impact.part ? IMPACT_PART_LABEL[impact.part] : FIELD_LABEL.get(impact.field) ?? impact.field}
            </span>
            <span className="copyable-text">{formatImpactValue(impact.currentValue)}</span>
            <span aria-hidden>→</span>
            <span className="copyable-text">{formatImpactValue(impact.nextValue)}</span>
            <strong>{IMPACT_ACTION_LABEL[impact.action]}</strong>
          </div>
        ))
      )}
      {unchanged.length > 0 ? (
        <details className="conflict-workbench-unchanged" open={unchangedInitiallyOpen}>
          <summary>{unchanged.length} 项保持不变</summary>
          {unchanged.map((impact, index) => (
            <div key={`${impact.field}-${impact.part ?? 'field'}-${index}`}>
              <span>
                {impact.part
                  ? IMPACT_PART_LABEL[impact.part]
                  : FIELD_LABEL.get(impact.field) ?? impact.field}
              </span>
              <span className="copyable-text">{formatImpactValue(impact.currentValue)}</span>
              <em>{IMPACT_PRESERVE_REASON_LABEL[impact.reason]}</em>
            </div>
          ))}
        </details>
      ) : null}
    </div>
  )
}

function SourceDetails({
  candidate,
  claim
}: {
  candidate: PendingActressScrapeCandidate | null
  claim: PendingActressNameClaim | null
}): JSX.Element {
  if (candidate) {
    const values = RESULT_FIELDS.flatMap(({ key, label }) => {
      const value = formatValue(candidate.result[key])
      return value ? [{ key, label, value }] : []
    })
    return (
      <div className="conflict-workbench-source-detail">
        <div className="conflict-workbench-source-heading">
          <ActressAvatar
            src={resolveMediaSrc(candidate.actressAvatarPath)}
            name={candidate.actressMainName}
            gender={null}
            decorative
          />
          <div>
            <strong>{candidate.actressMainName}</strong>
            <span>待确认刮削结果 · {candidate.plugin.name}</span>
          </div>
        </div>
        <dl className="conflict-workbench-meta-grid">
          <div><dt>插件</dt><dd>{candidate.plugin.name} · {candidate.plugin.source}</dd></div>
          <div><dt>查询名称</dt><dd className="copyable-text">{candidate.queryName}</dd></div>
          <div><dt>更新方式</dt><dd>{MODE_LABEL[candidate.mode]}</dd></div>
          <div><dt>实际字段</dt><dd>{candidateFieldLabel(candidate.applicableFields)}</dd></div>
        </dl>
        {values.length > 0 ? (
          <dl className="conflict-workbench-result-values">
            {values.map((field) => (
              <div key={field.key}><dt>{field.label}</dt><dd className="copyable-text">{field.value}</dd></div>
            ))}
          </dl>
        ) : (
          <p className="conflict-workbench-impact-note">插件没有返回非空资料字段。</p>
        )}
        {candidate.resources.length > 0 ? (
          <div className="conflict-workbench-resource-grid">
            {candidate.resources.slice(0, 8).map((resource) => (
              <img
                key={`${resource.field}-${resource.position}`}
                src={resolveMediaSrc(resource.stagedPath) ?? undefined}
                alt={resource.field === 'avatar' ? '待确认头像' : '待确认写真'}
                draggable={false}
              />
            ))}
          </div>
        ) : null}
        {candidate.warnings.length > 0 ? (
          <div className="conflict-workbench-warning" role="status">
            {candidate.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        ) : null}
      </div>
    )
  }
  if (claim) {
    return (
      <div className="conflict-workbench-source-detail">
        <h3>历史名称声明</h3>
        <dl className="conflict-workbench-meta-grid">
          <div><dt>原始名称</dt><dd className="copyable-text">{claim.name}</dd></div>
          <div><dt>名称类型</dt><dd>{NAME_TYPE_LABEL[claim.type]}</dd></div>
          <div><dt>演员 ID</dt><dd className="copyable-text">{claim.actressId}</dd></div>
          <div><dt>是否主名称</dt><dd>{claim.isPrimary ? '是' : '否'}</dd></div>
          <div><dt>区域</dt><dd className="copyable-text">{claim.locale || '未记录'}</dd></div>
          <div><dt>来源</dt><dd className="copyable-text">{claim.source || '数据库迁移'}</dd></div>
        </dl>
      </div>
    )
  }
  return <EmptyState title="请选择冲突来源" variant="fill" />
}

export default function ActressConflictReviewPage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const toast = useToast()
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const completeButtonRef = useRef<HTMLButtonElement>(null)
  const groupButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const replacementValidationSeq = useRef(0)
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectionGroupName, setSelectionGroupName] = useState<string | null>(null)
  const [selection, setSelection] = useState<ConflictReviewSelection | null>(null)
  const [focusAfterRefresh, setFocusAfterRefresh] = useState<string | null | undefined>(undefined)
  const [staleMessage, setStaleMessage] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [discardCandidate, setDiscardCandidate] = useState<PendingActressScrapeCandidate | null>(null)
  const [otherOwnerOpen, setOtherOwnerOpen] = useState(false)
  const [otherOwnerSearch, setOtherOwnerSearch] = useState('')
  const [otherOwnerOptions, setOtherOwnerOptions] = useState<ActressListItem[]>([])
  const [otherOwnerLoading, setOtherOwnerLoading] = useState(false)
  const [selectedOtherOwner, setSelectedOtherOwner] = useState<ActressListItem | null>(null)
  const [editNameOpen, setEditNameOpen] = useState(false)
  const [editedName, setEditedName] = useState('')
  const [liveEditInspection, setLiveEditInspection] = useState<{
    normalizedName: string
    status: 'available' | 'conflict'
  } | null>(null)
  const [editInspectionLoading, setEditInspectionLoading] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [replacementDialog, setReplacementDialog] = useState<'ownership' | 'illegal' | null>(null)
  const [replacementMainNames, setReplacementMainNames] = useState<Record<number, string>>({})
  const [replacementValidationStatus, setReplacementValidationStatus] =
    useState<IllegalNameReplacementValidationStatus>('idle')
  const [replacementValidationErrors, setReplacementValidationErrors] =
    useState<Record<number, string>>({})
  const debouncedOwnerSearch = useDebounce(otherOwnerSearch, 250)
  const debouncedEditedName = useDebounce(editedName, 250)

  const groupsQuery = useQuery({
    queryKey: actressKeys.conflicts(),
    queryFn: () => api.actressScrape.listConflicts()
  })
  const summaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary()
  })
  const groups = groupsQuery.data ?? []
  const sections = useMemo(() => buildConflictQueueSections(groups), [groups])
  const selectedGroup =
    groups.find((group) => group.normalizedName === selectedName) ?? groups[0] ?? null
  const selectedCandidate =
    selection?.source?.kind === 'scrape'
      ? selectedGroup?.candidates.find((candidate) => candidate.pendingId === selection.source?.id) ?? null
      : null
  const selectedClaim =
    selection?.source?.kind === 'claim'
      ? selectedGroup?.pendingNameClaims.find((claim) => claim.claimId === selection.source?.id) ?? null
      : null
  const selectedConflict =
    selectedCandidate?.conflicts.find(
      (conflict) => conflict.normalizedName === selectedGroup?.normalizedName
    ) ?? null
  const ownerOptions = useMemo(
    () => (selectedGroup ? buildOwnerOptions(selectedGroup) : []),
    [selectedGroup]
  )
  const mergeActors = useMemo(
    () => (selectedGroup ? buildActressConflictMergeActors(selectedGroup) : []),
    [selectedGroup]
  )
  const proposedOwner = selection?.proposedOwner ?? null
  const ownershipReplacementClaimants = useMemo(
    () =>
      selectedGroup
        ? conflictClaimantsNeedingReplacement(selectedGroup, proposedOwner?.actressId)
        : [],
    [proposedOwner?.actressId, selectedGroup]
  )
  const illegalReplacementClaimants = useMemo(
    () => (selectedGroup ? conflictClaimantsNeedingReplacement(selectedGroup, null) : []),
    [selectedGroup]
  )
  const requiredReplacementClaimants =
    replacementDialog === 'ownership'
      ? ownershipReplacementClaimants
      : replacementDialog === 'illegal'
        ? illegalReplacementClaimants
        : []
  const replacementInputs = useMemo(
    () =>
      requiredReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNames[claimant.actressId] ?? ''
      })),
    [replacementMainNames, requiredReplacementClaimants]
  )
  const debouncedReplacementInputs = useDebounce(replacementInputs, 250)
  const editSourceName = selectedConflict?.name ?? selectedClaim?.name ?? ''
  const editSourceType = selectedConflict?.type ?? selectedClaim?.type ?? null
  const localEditInspection = inspectConflictNameEdit(editSourceName, editedName, groups)
  const editInspection =
    localEditInspection.status === 'empty' || localEditInspection.status === 'unchanged'
      ? localEditInspection
      : liveEditInspection
        ? {
            normalizedName: liveEditInspection.normalizedName,
            status: liveEditInspection.status,
            targetGroupName:
              liveEditInspection.status === 'conflict'
                ? localEditInspection.targetGroupName
                : null
          }
        : localEditInspection
  const editInspectionPending =
    localEditInspection.status !== 'empty' &&
    localEditInspection.status !== 'unchanged' &&
    (editInspectionLoading || editedName !== debouncedEditedName || !liveEditInspection)
  const summary = summaryQuery.data

  const resetTransientState = useCallback((): void => {
    setOtherOwnerOpen(false)
    setOtherOwnerSearch('')
    setSelectedOtherOwner(null)
    setEditNameOpen(false)
    setMergeOpen(false)
    setReplacementDialog(null)
    setReplacementMainNames({})
    setReplacementValidationStatus('idle')
    setReplacementValidationErrors({})
  }, [])

  useEffect(() => {
    if (!selectedGroup) {
      setSelectedName(null)
      setSelection(null)
      setSelectionGroupName(null)
      return
    }
    if (selectedName !== selectedGroup.normalizedName) {
      setSelectedName(selectedGroup.normalizedName)
    }
    if (selectionGroupName !== selectedGroup.normalizedName) {
      setSelection(createConflictReviewSelection(selectedGroup))
      setSelectionGroupName(selectedGroup.normalizedName)
      resetTransientState()
    }
  }, [resetTransientState, selectedGroup, selectedName, selectionGroupName])

  useEffect(() => {
    if (focusAfterRefresh === undefined) return
    const target = focusAfterRefresh
      ? groupButtonRefs.current.get(focusAfterRefresh)
      : completeButtonRef.current ?? backButtonRef.current
    target?.focus()
    setFocusAfterRefresh(undefined)
  }, [focusAfterRefresh])

  useEffect(() => {
    if (!otherOwnerOpen) return
    let cancelled = false
    setOtherOwnerLoading(true)
    void api.actresses
      .list(debouncedOwnerSearch.trim(), 'all')
      .then((items) => {
        if (cancelled) return
        const visibleItems = items
          .filter((item) => ownerOptions.every((owner) => owner.actressId !== item.id))
          .slice(0, 40)
        const shouldKeepSelectedVisible =
          debouncedOwnerSearch.trim() === '' &&
          selectedOtherOwner != null &&
          !visibleItems.some((item) => item.id === selectedOtherOwner.id)
        setOtherOwnerOptions(
          shouldKeepSelectedVisible
            ? [selectedOtherOwner, ...visibleItems].slice(0, 40)
            : visibleItems
        )
      })
      .catch((error) => {
        if (!cancelled) toast.show(String((error as Error).message), 'error')
      })
      .finally(() => {
        if (!cancelled) setOtherOwnerLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [debouncedOwnerSearch, otherOwnerOpen, ownerOptions, selectedOtherOwner, toast])

  useEffect(() => {
    setLiveEditInspection(null)
    if (!editNameOpen || !selectedGroup) {
      setEditInspectionLoading(false)
      return
    }
    const local = inspectConflictNameEdit(editSourceName, debouncedEditedName, groups)
    const actressId = selectedCandidate?.actressId ?? selectedClaim?.actressId
    if (
      actressId == null ||
      local.status === 'empty' ||
      local.status === 'unchanged'
    ) {
      setEditInspectionLoading(false)
      return
    }
    let cancelled = false
    setEditInspectionLoading(true)
    void api.actressScrape
      .inspectConflictName({
        actressId,
        name: debouncedEditedName,
        ...(selectedCandidate ? { pendingId: selectedCandidate.pendingId } : {})
      })
      .then((inspection) => {
        if (!cancelled) setLiveEditInspection(inspection)
      })
      .catch((error) => {
        if (!cancelled) toast.show(String((error as Error).message), 'error')
      })
      .finally(() => {
        if (!cancelled) setEditInspectionLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    debouncedEditedName,
    editNameOpen,
    editSourceName,
    groups,
    selectedCandidate,
    selectedClaim,
    selectedGroup,
    toast
  ])

  useEffect(() => {
    replacementValidationSeq.current += 1
    setReplacementValidationErrors({})
    if (!replacementDialog) {
      setReplacementValidationStatus('idle')
    } else if (requiredReplacementClaimants.length === 0) {
      setReplacementValidationStatus('valid')
    } else if (replacementInputs.some((replacement) => !replacement.mainName.trim())) {
      setReplacementValidationStatus('idle')
    } else {
      setReplacementValidationStatus('checking')
    }
  }, [replacementDialog, replacementInputs, requiredReplacementClaimants.length])

  useEffect(() => {
    if (
      !replacementDialog ||
      !selectedGroup ||
      requiredReplacementClaimants.length === 0 ||
      debouncedReplacementInputs.some((replacement) => !replacement.mainName.trim())
    ) {
      return
    }
    const seq = replacementValidationSeq.current
    void api.actressScrape
      .validateIllegalNameReplacements({
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        replacementMainNames: debouncedReplacementInputs,
        ...(replacementDialog === 'ownership' && proposedOwner
          ? { destinationOwnerActressId: proposedOwner.actressId }
          : {})
      })
      .then((result) => {
        if (seq !== replacementValidationSeq.current) return
        if (result.status === 'valid') {
          setReplacementValidationStatus('valid')
          return
        }
        if (result.status === 'invalid') {
          setReplacementValidationStatus('invalid')
          setReplacementValidationErrors(
            Object.fromEntries(result.errors.map((error) => [error.actressId, error.message]))
          )
          return
        }
        setReplacementDialog(null)
        setStaleMessage('数据已变化，已刷新，请重新确认')
        setSelection((current) =>
          current ? selectConflictProposedOwner(current, null) : current
        )
        setSelectedOtherOwner(null)
        void invalidateActressLibraryQueries(queryClient)
      })
      .catch((error) => {
        if (seq !== replacementValidationSeq.current) return
        setReplacementValidationStatus('invalid')
        toast.show(String((error as Error).message), 'error')
      })
  }, [
    debouncedReplacementInputs,
    queryClient,
    proposedOwner,
    replacementDialog,
    requiredReplacementClaimants.length,
    selectedGroup,
    toast
  ])

  const chooseGroup = (group: ActressNameConflictGroup): void => {
    setStaleMessage(null)
    setSelectedName(group.normalizedName)
    setSelectionGroupName(group.normalizedName)
    setSelection(createConflictReviewSelection(group))
    resetTransientState()
  }

  const selectAfterRefresh = (
    previousGroups: ActressNameConflictGroup[],
    refreshedGroups: ActressNameConflictGroup[],
    previousSelectedName: string | null,
    stale = false
  ): void => {
    const next = buildConflictReviewRefreshState(
      previousGroups,
      refreshedGroups,
      previousSelectedName,
      stale
    )
    setSelectedName(next.selectedNormalizedName)
    setSelectionGroupName(null)
    setSelection(next.selection)
    setStaleMessage(next.staleMessage)
    setFocusAfterRefresh(
      next.focusTarget.kind === 'group' ? next.focusTarget.normalizedName : null
    )
  }

  const resolveDecision = async (input: ResolveActressConflictInput): Promise<void> => {
    if (resolving) return
    const previousGroups = groups
    const previousSelectedName = selectedGroup?.normalizedName ?? null
    setResolving(true)
    try {
      const outcome = await api.actressScrape.resolveConflict(input)
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      if (outcome.status === 'stale') {
        setReplacementDialog(null)
        toast.show(outcome.message, 'info')
      } else {
        resetTransientState()
        toast.show('名称冲突已处理', 'success')
      }
      selectAfterRefresh(
        previousGroups,
        refreshed.data ?? [],
        previousSelectedName,
        outcome.status === 'stale'
      )
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      setResolving(false)
    }
  }

  const submitOwnership = (): void => {
    if (!selectedGroup || !proposedOwner) return
    void resolveDecision({
      kind: 'assignToExistingActress',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      ownerActressId: proposedOwner.actressId,
      ownerActressRevision: proposedOwner.revision,
      replacementMainNames: ownershipReplacementClaimants.map((claimant) => ({
        actressId: claimant.actressId,
        mainName: replacementMainNames[claimant.actressId] ?? ''
      }))
    })
  }

  const confirmOwnership = (): void => {
    if (!proposedOwner) return
    if (ownershipReplacementClaimants.length > 0) {
      setReplacementMainNames({})
      setReplacementDialog('ownership')
      return
    }
    submitOwnership()
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

  const submitEditedName = (): void => {
    if (
      !selectedGroup ||
      !editSourceType ||
      editInspectionPending ||
      editInspection.status === 'empty' ||
      editInspection.status === 'unchanged'
    ) return
    if (selectedCandidate && selectedConflict) {
      void resolveDecision({
        kind: 'editName',
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        pendingId: selectedCandidate.pendingId,
        name: selectedConflict.name,
        nameType: selectedConflict.type,
        newName: editedName,
        replacementMainNames: []
      })
      return
    }
    if (selectedClaim) {
      void resolveDecision({
        kind: 'editPendingNameClaim',
        snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
        claimId: selectedClaim.claimId,
        actressId: selectedClaim.actressId,
        name: selectedClaim.name,
        nameType: selectedClaim.type,
        newName: editedName,
        replacementMainNames: []
      })
    }
  }

  const submitIllegalName = (): void => {
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

  const submitMerge = (decision: ConflictMergeActressesDecision): void => {
    if (!selectedGroup) return
    const pending = selectedGroup.candidates.find(
      (candidate) =>
        candidate.actressId === decision.keepActressId ||
        candidate.actressId === decision.mergeActressId
    )
    void resolveDecision({
      kind: 'mergeActresses',
      snapshot: buildActressConflictDecisionSnapshot(selectedGroup),
      ...(pending ? { pendingId: pending.pendingId } : {}),
      ...decision,
      replacementMainNames: []
    })
  }

  const discard = async (): Promise<void> => {
    if (!discardCandidate || discarding) return
    const previousGroups = groups
    const previousSelectedName = selectedGroup?.normalizedName ?? null
    setDiscarding(true)
    try {
      await api.actressScrape.discardConflict({
        pendingId: discardCandidate.pendingId,
        expectedRevision: discardCandidate.revision
      })
      setDiscardCandidate(null)
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      selectAfterRefresh(previousGroups, refreshed.data ?? [], previousSelectedName)
      toast.show('已丢弃错误匹配并清理暂存资源', 'success')
    } catch (error) {
      const message = String((error as Error).message)
      await invalidateActressLibraryQueries(queryClient)
      const refreshed = await groupsQuery.refetch()
      setDiscardCandidate(null)
      selectAfterRefresh(previousGroups, refreshed.data ?? [], previousSelectedName, true)
      toast.show(message, 'error')
    } finally {
      setDiscarding(false)
    }
  }

  const chooseOtherOwner = async (item: ActressListItem): Promise<void> => {
    try {
      const detail = item.revision == null ? await api.actresses.get(item.id) : null
      const revision = item.revision ?? detail?.revision
      if (revision == null) throw new Error('无法读取演员当前版本，请刷新后重试')
      setSelection((current) =>
        current
          ? selectConflictProposedOwner(current, {
              actressId: item.id,
              revision,
              mainName: item.main_name
            })
          : current
      )
      setSelectedOtherOwner(item)
      setOtherOwnerOpen(false)
      setOtherOwnerSearch('')
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const openEditName = (): void => {
    if (!editSourceName) return
    setEditedName(editSourceName)
    setEditNameOpen(true)
  }

  const openIllegalName = (): void => {
    setReplacementMainNames({})
    setReplacementDialog('illegal')
  }

  const renderQueueSection = (
    title: string,
    queue: ActressNameConflictGroup[]
  ): JSX.Element | null => {
    if (queue.length === 0) return null
    return (
      <section className="conflict-workbench-queue-section">
        <h2>{title}<span>{queue.length}</span></h2>
        {queue.map((group) => (
          <button
            key={group.normalizedName}
            ref={(button) => {
              if (button) groupButtonRefs.current.set(group.normalizedName, button)
              else groupButtonRefs.current.delete(group.normalizedName)
            }}
            type="button"
            className={`conflict-workbench-group${
              selectedGroup?.normalizedName === group.normalizedName ? ' is-selected' : ''
            }`}
            onClick={() => chooseGroup(group)}
          >
            <strong>{group.displayName}</strong>
            <span>
              刮削 {group.candidates.length} · 历史 {group.pendingNameClaims.length} · 可应用{' '}
              {group.candidates.filter((candidate) => candidate.willApplyAfterDecision).length}
            </span>
          </button>
        ))}
      </section>
    )
  }

  return (
    <div className="detail-pane conflict-review-page">
      <WorkbenchShell className="conflict-workbench-shell">
        <nav className="conflict-workbench-breadcrumb" aria-label="当前位置">
          <button
            ref={backButtonRef}
            type="button"
            className="settings-back-link"
            onClick={() => navigateToActressList(navigate, location)}
          >
            演员
          </button>
          <span>/</span>
          <strong>名称冲突</strong>
        </nav>

        <WorkbenchToolbar className="conflict-workbench-toolbar">
          <div>
            <h1>演员名称冲突</h1>
            <p>同一个名称被多位演员使用，请确认它的唯一归属。</p>
          </div>
          <div className="conflict-workbench-toolbar-summary">
            <span>
              冲突 {summary?.conflictGroupCount ?? 0} · 可应用 {summary?.applicableGroupCount ?? 0}
            </span>
            <WorkbenchStatusPill>
              待处理 {summary?.groupCount ?? groups.length} 组
            </WorkbenchStatusPill>
          </div>
        </WorkbenchToolbar>

        {groupsQuery.isLoading ? (
          <WorkbenchMain className="conflict-workbench-main" aria-busy="true">
            <WorkbenchRail className="conflict-workbench-rail" aria-label="名称冲突组">
              <WorkbenchRailHeader>
                <span>待处理名称</span>
                <span>加载中</span>
              </WorkbenchRailHeader>
              <EmptyState loading variant="fill" />
            </WorkbenchRail>
            <section className="conflict-workbench-workspace">
              <EmptyState loading variant="fill" />
            </section>
          </WorkbenchMain>
        ) : groups.length === 0 ? (
          <div className="conflict-workbench-complete">
            <EmptyState
              icon={<UserRoundCheck {...UI_ICON_SM} aria-hidden />}
              title="名称冲突已全部处理"
              description="没有待确认的名称归属或刮削结果。"
              variant="fill"
            />
            <button
              ref={completeButtonRef}
              type="button"
              className="btn btn-primary"
              onClick={() => navigateToActressList(navigate, location)}
            >
              <ArrowLeft {...UI_ICON_SM} aria-hidden />返回演员
            </button>
          </div>
        ) : (
          <WorkbenchMain className="conflict-workbench-main">
            <WorkbenchRail className="conflict-workbench-rail" aria-label="名称冲突组">
              <WorkbenchRailHeader>
                <span>待处理名称</span>
                <span>{groups.length} 组</span>
              </WorkbenchRailHeader>
              <div className="conflict-workbench-group-list">
                {renderQueueSection('待确认', sections.pending)}
                {renderQueueSection('可应用', sections.applicable)}
              </div>
            </WorkbenchRail>

            {selectedGroup && selection ? (
              <section className="conflict-workbench-workspace">
                <header className="conflict-workbench-question">
                  <div>
                    <span>{selectedGroup.status === 'applicable' ? '资料等待应用' : '整个名称组'}</span>
                    <h2>
                      {selectedGroup.status === 'applicable'
                        ? `「${selectedGroup.displayName}」的冲突已消失`
                        : `「${selectedGroup.displayName}」应该属于哪位演员？`}
                    </h2>
                    <p>
                      {selectedGroup.status === 'applicable'
                          ? '名称冲突已消失，资料仍未写入。请选择来源查看影响后明确应用或丢弃。'
                          : selectedCandidate
                            ? `${selectedCandidate.plugin.name} 为「${selectedCandidate.actressMainName}」返回了名称「${selectedGroup.displayName}」；当前该名称归属于「${selectedGroup.currentOwner?.mainName ?? '暂无演员'}」，请结合来源资料确认。`
                            : '多位演员保存了同一个名称，请确认最终归属，或选择其他处理方式。'}
                    </p>
                  </div>
                  <WorkbenchStatusPill className={selectedGroup.status === 'conflict' ? 'is-waiting' : 'is-ok'}>
                    {selectedGroup.status === 'conflict' ? '待确认' : '可应用'}
                  </WorkbenchStatusPill>
                </header>

                {staleMessage ? (
                  <div className="conflict-workbench-stale" role="status">
                    <CircleAlert {...UI_ICON_SM} aria-hidden />{staleMessage}
                  </div>
                ) : null}

                <WorkbenchTabs
                  id="actress-conflict-tab"
                  label="冲突工作区"
                  value={selection.tab}
                  className="conflict-workbench-tabs"
                  items={[
                    { id: 'process', label: '处理', panelId: 'actress-conflict-panel-process' },
                    { id: 'source', label: '来源详情', panelId: 'actress-conflict-panel-source' }
                  ]}
                  onChange={(tab) => setSelection((current) => current ? { ...current, tab } : current)}
                />

                <div className="conflict-workbench-panel-stack">
                  <div
                    id="actress-conflict-panel-process"
                    role="tabpanel"
                    aria-labelledby="actress-conflict-tab-process"
                    hidden={selection.tab !== 'process'}
                    className="conflict-workbench-panel"
                  >
                    {selectedGroup.status === 'conflict' ? (
                      <section className="conflict-workbench-section">
                        <div className="conflict-workbench-section-title">
                          <div><span>第 1 步</span><h3>选择名称归属</h3></div>
                          <small>选择只会生成预览，不会立即写入</small>
                        </div>
                        <div className="conflict-workbench-owner-grid" role="group" aria-label="名称归属">
                          {ownerOptions.map((owner) => (
                            <button
                              key={owner.actressId}
                              type="button"
                              aria-pressed={proposedOwner?.actressId === owner.actressId}
                              className={`conflict-workbench-owner${
                                proposedOwner?.actressId === owner.actressId ? ' is-selected' : ''
                              }`}
                              onClick={() => {
                                setSelectedOtherOwner(null)
                                setSelection((current) =>
                                  current
                                    ? selectConflictProposedOwner(current, {
                                        actressId: owner.actressId,
                                        revision: owner.revision,
                                        mainName: owner.mainName
                                      })
                                    : current
                                )
                              }}
                            >
                              <ActressAvatar
                                src={resolveMediaSrc(owner.avatarPath)}
                                name={owner.mainName}
                                gender={null}
                                decorative
                              />
                              <span><strong>{owner.mainName}</strong><small>{owner.roles.join(' · ')}</small></span>
                            </button>
                          ))}
                          <button
                            type="button"
                            aria-pressed={selectedOtherOwner != null}
                            className={`conflict-workbench-owner conflict-workbench-owner--other${
                              selectedOtherOwner ? ' is-selected' : ''
                            }`}
                            onClick={() => {
                              setOtherOwnerSearch('')
                              setOtherOwnerOpen(true)
                            }}
                          >
                            {selectedOtherOwner ? (
                              <>
                                <ActressAvatar
                                  src={resolveMediaSrc(selectedOtherOwner.avatar_path)}
                                  name={selectedOtherOwner.main_name}
                                  gender={selectedOtherOwner.gender}
                                  decorative
                                />
                                <span>
                                  <strong>{selectedOtherOwner.main_name}</strong>
                                  <small>已从演员库选择 · 点击重新选择</small>
                                </span>
                              </>
                            ) : (
                              <>
                                <UserRoundSearch {...UI_ICON_SM} aria-hidden />
                                <span><strong>选择其他演员…</strong><small>从演员库搜索组外演员</small></span>
                              </>
                            )}
                          </button>
                        </div>
                      </section>
                    ) : null}

                    <section className="conflict-workbench-section">
                      <div className="conflict-workbench-section-title">
                        <div><span>{selectedGroup.status === 'conflict' ? '第 2 步' : '第 1 步'}</span><h3>选择冲突来源</h3></div>
                        <small>只影响详情、改名和错误匹配丢弃</small>
                      </div>
                      <div className="conflict-workbench-source-list" role="group" aria-label="冲突来源">
                        {selectedGroup.candidates.map((candidate) => (
                          <button
                            key={`scrape-${candidate.pendingId}`}
                            type="button"
                            aria-pressed={selection.source?.kind === 'scrape' && selection.source.id === candidate.pendingId}
                            className={selection.source?.kind === 'scrape' && selection.source.id === candidate.pendingId ? 'is-selected' : ''}
                            onClick={() => setSelection((current) => current ? selectConflictSource(current, { kind: 'scrape', id: candidate.pendingId }) : current)}
                          >
                            <ActressAvatar src={resolveMediaSrc(candidate.actressAvatarPath)} name={candidate.actressMainName} gender={null} decorative />
                            <span><strong>{candidate.actressMainName}</strong><small>刮削结果 · {candidate.plugin.name} · {MODE_LABEL[candidate.mode]}</small></span>
                            <em>{candidate.willApplyAfterDecision ? '本次可解锁' : `仍有 ${candidate.remainingConflictCountAfterDecision} 个冲突`}</em>
                          </button>
                        ))}
                        {selectedGroup.pendingNameClaims.map((claim) => {
                          const claimant = selectedGroup.claimants.find((item) => item.actressId === claim.actressId)
                          return (
                            <button
                              key={`claim-${claim.claimId}`}
                              type="button"
                              aria-pressed={selection.source?.kind === 'claim' && selection.source.id === claim.claimId}
                              className={selection.source?.kind === 'claim' && selection.source.id === claim.claimId ? 'is-selected' : ''}
                              onClick={() => setSelection((current) => current ? selectConflictSource(current, { kind: 'claim', id: claim.claimId }) : current)}
                            >
                              <ActressAvatar src={resolveMediaSrc(claimant?.avatarPath)} name={claimant?.mainName ?? claim.name} gender={null} decorative />
                              <span><strong>{claimant?.mainName ?? `演员 #${claim.actressId}`}</strong><small>历史声明 · {NAME_TYPE_LABEL[claim.type]}</small></span>
                              <em>当前来源</em>
                            </button>
                          )
                        })}
                      </div>
                    </section>

                    <section className="conflict-workbench-section">
                      <div className="conflict-workbench-section-title">
                        <div><span>{selectedGroup.status === 'conflict' ? '第 3 步' : '第 2 步'}</span><h3>查看确认后的影响</h3></div>
                        <small>{selectedGroup.candidates.filter((candidate) => candidate.willApplyAfterDecision).length} 份资料可在本次处理后应用</small>
                      </div>
                      {selectedGroup.status === 'conflict' && proposedOwner ? (
                        <div className="conflict-workbench-name-impact">
                          <strong>名称归属</strong>
                          <span>「{selectedGroup.displayName}」将唯一归属「{proposedOwner.mainName}」</span>
                          <ul>
                            {selectedGroup.claimants
                              .filter((claimant) => claimant.actressId !== proposedOwner.actressId)
                              .map((claimant) => (
                                <li key={`claimant-${claimant.actressId}`}>
                                  「{claimant.mainName}」将不再使用名称「{selectedGroup.displayName}」
                                  {claimant.nameTypes.includes('main')
                                    ? `；需将主名改为「${replacementMainNames[claimant.actressId]?.trim() || '尚未设置'}」`
                                    : ''}
                                </li>
                              ))}
                            {selectedGroup.candidates.flatMap((candidate) =>
                              candidate.conflicts
                                .filter((conflict) => conflict.normalizedName === selectedGroup.normalizedName)
                                .map((conflict) => (
                                  <li key={`candidate-${candidate.pendingId}-${conflict.type}-${conflict.name}`}>
                                    {candidate.actressId === proposedOwner.actressId
                                      ? `「${candidate.actressMainName}」的待确认资料将保留名称「${conflict.name}」，该名称冲突会被解除`
                                      : `「${candidate.actressMainName}」的待确认资料将不再写入名称「${conflict.name}」`}
                                  </li>
                                ))
                            )}
                          </ul>
                        </div>
                      ) : selectedGroup.status === 'conflict' ? (
                        <div className="conflict-workbench-impact-placeholder">
                          先选择一位演员，才能确认名称归属影响。
                        </div>
                      ) : null}
                      <div className="conflict-workbench-candidate-impacts">
                        {selectedGroup.candidates.map((candidate) => (
                          <details key={candidate.pendingId} open={candidate.pendingId === selectedCandidate?.pendingId}>
                            <summary>
                              <span>资料写回「{candidate.actressMainName}」</span>
                              <em>{candidate.willApplyAfterDecision ? '精确字段影响' : '继续等待'}</em>
                            </summary>
                            <ImpactRows
                              candidate={candidate}
                              impacts={conflictFieldImpactsForProposedOwner(
                                candidate,
                                proposedOwner
                              )}
                            />
                          </details>
                        ))}
                        {selectedGroup.candidates.length === 0 ? (
                          <p className="conflict-workbench-impact-note">这是历史名称归属，不包含刮削资料。</p>
                        ) : null}
                      </div>
                    </section>

                  </div>

                  <div
                    id="actress-conflict-panel-source"
                    role="tabpanel"
                    aria-labelledby="actress-conflict-tab-source"
                    hidden={selection.tab !== 'source'}
                    className="conflict-workbench-panel"
                  >
                    <SourceDetails candidate={selectedCandidate} claim={selectedClaim} />
                  </div>
                </div>

                <footer className="conflict-workbench-confirm">
                  <div>
                    <strong>
                      {selectedGroup.status === 'applicable'
                        ? selectedCandidate
                          ? `资料将写回「${selectedCandidate.actressMainName}」`
                          : '请选择一份待确认资料'
                        : proposedOwner
                          ? `拟定归属：${proposedOwner.mainName}`
                          : '尚未选择名称归属'}
                    </strong>
                    <span>
                      作用范围：{CONFLICT_ACTION_SCOPE_LABEL[
                        selectedGroup.status === 'applicable'
                          ? 'applyPending'
                          : 'assignOwnership'
                      ]}
                    </span>
                  </div>
                  <div>
                    {selectedCandidate ? (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={resolving} onClick={() => setDiscardCandidate(selectedCandidate)}>
                        <Trash2 {...UI_ICON_SM} aria-hidden />
                        {selectedGroup.status === 'applicable' ? '丢弃这份结果' : '丢弃这份错误匹配'}
                      </button>
                    ) : null}
                    {selectedGroup.status === 'applicable' ? (
                      <button type="button" className="btn btn-sm btn-primary" disabled={resolving || !selectedCandidate} onClick={applySelectedPending}>
                        应用待确认资料
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-primary" disabled={resolving || !proposedOwner} onClick={confirmOwnership}>
                        {resolving ? '处理中…' : '确认名称归属'}
                      </button>
                    )}
                  </div>
                </footer>

                {selectedGroup.status === 'conflict' ? (
                  <div className="conflict-workbench-secondary-actions" aria-label="其他处理方式">
                    <span>其他处理</span>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={!editSourceName || resolving} onClick={openEditName}>
                      <Pencil {...UI_ICON_SM} aria-hidden />修改本条返回名称
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={mergeActors.length < 2 || resolving} onClick={() => setMergeOpen(true)}>
                      <GitMerge {...UI_ICON_SM} aria-hidden />合并演员档案
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost conflict-workbench-illegal" disabled={resolving} onClick={openIllegalName}>
                      <Ban {...UI_ICON_SM} aria-hidden />这不是演员名称
                    </button>
                  </div>
                ) : null}
              </section>
            ) : (
              <EmptyState icon={<UsersRound {...UI_ICON_SM} />} title="请选择名称组" variant="fill" />
            )}
          </WorkbenchMain>
        )}
      </WorkbenchShell>

      {otherOwnerOpen ? (
        <ConfirmModal
          title="选择其他演员"
          size="md"
          className="modal--conflict-owner-picker"
          bodyClassName="conflict-workbench-owner-modal-body"
          confirmText="选好后返回处理页确认"
          confirmDisabled
          onConfirm={() => undefined}
          onCancel={() => { setOtherOwnerOpen(false); setOtherOwnerSearch('') }}
        >
          <p>这里只选择拟定归属；不会在弹窗内提交名称变更。</p>
          <div className="conflict-workbench-owner-picker">
            <input
              type="search"
              className="search-input form-control-full"
              placeholder="搜索演员主名或别名…"
              value={otherOwnerSearch}
              onChange={(event) => setOtherOwnerSearch(event.target.value)}
            />
            <div className="conflict-workbench-owner-search" role="group" aria-label="其他演员">
              {otherOwnerLoading ? (
                <EmptyState loading variant="modal" />
              ) : otherOwnerOptions.length === 0 ? (
                <EmptyState title="没有匹配的演员" variant="modal" />
              ) : otherOwnerOptions.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selectedOtherOwner?.id === item.id}
                  className={selectedOtherOwner?.id === item.id ? 'is-selected' : ''}
                  onClick={() => void chooseOtherOwner(item)}
                >
                  <ActressAvatar src={resolveMediaSrc(item.avatar_path)} name={item.main_name} gender={item.gender} decorative />
                  <span><strong>{item.main_name}</strong><small>{item.video_count} 部影片</small></span>
                </button>
              ))}
            </div>
          </div>
        </ConfirmModal>
      ) : null}

      {editNameOpen && selectedGroup && editSourceType ? (
        <ConfirmModal
          title="修改本条返回名称"
          size="sm"
          confirmText={resolving ? '处理中…' : '确认修改'}
          confirmDisabled={resolving || editInspectionPending || editInspection.status === 'empty' || editInspection.status === 'unchanged'}
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={submitEditedName}
          onCancel={() => setEditNameOpen(false)}
        >
          <dl className="conflict-workbench-edit-context">
            <div><dt>当前名称</dt><dd className="copyable-text">{editSourceName}</dd></div>
            <div><dt>名称类型</dt><dd>{NAME_TYPE_LABEL[editSourceType]}</dd></div>
            <div><dt>来源</dt><dd>{selectedCandidate ? `${selectedCandidate.plugin.name} · ${selectedCandidate.actressMainName}` : '历史名称声明'}</dd></div>
            <div><dt>作用范围</dt><dd>{CONFLICT_ACTION_SCOPE_LABEL.editName}</dd></div>
          </dl>
          <label className="conflict-workbench-edit-field">
            <span>新名称</span>
            <input autoFocus className="text-input form-control-full" value={editedName} onChange={(event) => setEditedName(event.target.value)} />
          </label>
          <div className="conflict-workbench-edit-inspection" role="status">
            <span>标准化结果</span>
            <strong className="copyable-text">{editInspection.normalizedName || '空'}</strong>
            <em>
              {editInspectionPending
                ? '正在检查实时名称归属…'
                : editInspection.status === 'empty'
                ? '名称不能为空'
                : editInspection.status === 'unchanged'
                  ? '名称没有变化'
                  : editInspection.status === 'conflict'
                    ? editInspection.targetGroupName
                      ? `仍有冲突，将移动到「${editInspection.targetGroupName}」组`
                      : '该名称已被其他演员使用，提交后将进入对应冲突组'
                    : '实时检查未发现名称冲突'}
            </em>
          </div>
        </ConfirmModal>
      ) : null}

      {replacementDialog && selectedGroup ? (
        <ConfirmModal
          title={replacementDialog === 'illegal' ? `从本组删除「${selectedGroup.displayName}」` : `确认归属给「${proposedOwner?.mainName ?? ''}」`}
          size="sm"
          danger={replacementDialog === 'illegal'}
          confirmText={resolving ? '处理中…' : replacementDialog === 'illegal' ? '确认从本组删除' : '确认名称归属'}
          confirmDisabled={
            resolving ||
            !canConfirmIllegalName(
              requiredReplacementClaimants,
              replacementMainNames,
              replacementValidationStatus
            )
          }
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={replacementDialog === 'illegal' ? submitIllegalName : submitOwnership}
          onCancel={() => { setReplacementDialog(null); setReplacementMainNames({}) }}
        >
          {replacementDialog === 'illegal' ? (
            <div>
              <p>这会删除该名称的现有归属和全部相关名称声明，并从本组所有待确认结果中排除该名称。</p>
              <p>其他有效资料继续写回原目标演员；不会保存黑名单、错误记录或长期规则。</p>
            </div>
          ) : (
            <p>该名称当前是下列演员的主名。转移归属前，请为每位演员指定替代主名；所有更改将通过同一事务提交。</p>
          )}
          {requiredReplacementClaimants.map((claimant, index) => {
            const error = replacementValidationErrors[claimant.actressId]
            const errorId = `conflict-replacement-error-${claimant.actressId}`
            return (
              <label className="conflict-workbench-edit-field" key={claimant.actressId}>
                <span>为「{claimant.mainName}」填写替代主名</span>
                <input
                  autoFocus={index === 0}
                  className="text-input form-control-full"
                  value={replacementMainNames[claimant.actressId] ?? ''}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => setReplacementMainNames((current) => ({ ...current, [claimant.actressId]: event.target.value }))}
                />
                {error ? <small id={errorId} className="text-danger">{error}</small> : null}
              </label>
            )
          })}
          {requiredReplacementClaimants.length > 0 && replacementValidationStatus === 'checking' ? <p role="status">正在检查替代主名…</p> : null}
        </ConfirmModal>
      ) : null}

      {mergeOpen && selectedGroup ? (
        <ConflictMergeActressesModal
          key={selectedGroup.normalizedName}
          actors={mergeActors}
          busy={resolving}
          onConfirm={submitMerge}
          onCancel={() => setMergeOpen(false)}
        />
      ) : null}

      {discardCandidate ? (
        <ConfirmModal
          title={selectedGroup?.status === 'applicable' ? '丢弃这份结果' : '丢弃这份错误匹配'}
          danger
          confirmText={discarding ? '丢弃中…' : '确认丢弃'}
          busy={discarding}
          closeDisabled={discarding}
          onConfirm={() => void discard()}
          onCancel={() => setDiscardCandidate(null)}
        >
          <p>
            确认丢弃「{discardCandidate.actressMainName}」的
            {selectedGroup?.status === 'applicable' ? '待确认资料' : '整份刮削结果'}吗？
          </p>
          <p>作用范围：{CONFLICT_ACTION_SCOPE_LABEL.discardScrape}</p>
          <p>不会改变名称归属、历史声明或同组其他结果；该结果的暂存资源会被清理，并记录本次刮削失败。</p>
        </ConfirmModal>
      ) : null}
    </div>
  )
}
