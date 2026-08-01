import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CircleAlert, Trash2, UserRoundCheck, UsersRound } from 'lucide-react'
import type {
  ActressNameConflictGroup,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  PendingActressScrapeCandidate
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

const FIELD_LABEL = new Map(ACTRESS_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label]))

const MODE_LABEL: Record<ActressScrapeUpdateMode, string> = {
  replace: '覆盖更新',
  fillEmpty: '空字段补齐',
  replaceIfPresent: '有值覆盖'
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
                      {group.currentOwner ? `当前归属 · ${group.currentOwner.mainName}` : '当前无归属'}
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
                  <CircleAlert {...UI_ICON_SM} aria-hidden />待确认
                </span>
              </header>

              <section className="conflict-review-section">
                <div className="conflict-review-section-title">
                  <strong>当前归属与候选结果</strong>
                  <span>选择一份候选查看刮削详情</span>
                </div>
                <div className="conflict-review-actors">
                  {selectedGroup.currentOwner ? (
                    <div className="conflict-review-owner">
                      <ActressAvatar
                        src={resolveMediaSrc(selectedGroup.currentOwner.avatarPath)}
                        name={selectedGroup.currentOwner.mainName}
                        gender={null}
                      />
                      <span>
                        <strong>{selectedGroup.currentOwner.mainName}</strong>
                        <small>当前归属 · {selectedGroup.currentOwner.nameTypes.join(' / ')}</small>
                      </span>
                      <UserRoundCheck {...UI_ICON_SM} aria-hidden />
                    </div>
                  ) : null}
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
