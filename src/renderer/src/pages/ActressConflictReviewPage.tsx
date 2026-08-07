import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
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
import type { ActressNameConflictGroup, ActressPendingNameType, PendingActressNameClaim, PendingActressScrapeCandidate } from '@shared/actressConflictTypes'
import type { ActressScrapeField, ActressScrapeFieldImpact, ActressScrapeUpdateMode } from '@shared/scrapeTypes'
import { ACTRESS_SCRAPE_FIELD_OPTIONS } from '@shared/scrapeTypes'
import { resolveMediaSrc } from '../api'
import ActressAvatar from '../components/ActressAvatar'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import { UI_ICON_SM } from '../components/iconDefaults'
import {
  WorkbenchMain,
  WorkbenchRail,
  WorkbenchRailHeader,
  WorkbenchShell,
  WorkbenchStatusPill,
  WorkbenchTabs,
  WorkbenchToolbar
} from '../components/workbench'
import { navigateToActressList } from '../listView/listNavigation'
import ConflictMergeActressesModal from './ConflictMergeActressesModal'
import {
  canConfirmIllegalName,
  CONFLICT_ACTION_SCOPE_LABEL,
  conflictFieldImpactsForProposedOwner,
  partitionConflictFieldImpacts
} from './actressConflictReviewState'
import { useConflictReviewController } from './useConflictReviewController'

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
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const completeButtonRef = useRef<HTMLButtonElement>(null)
  const groupButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const controller = useConflictReviewController()
  const {
    groupsQuery, summary, groups, sections, selectedGroup, selectedCandidate, selectedClaim,
    selectedConflict, ownerOptions, mergeActors, proposedOwner, ownershipReplacementClaimants,
    illegalReplacementClaimants, requiredReplacementClaimants, selection, staleMessage,
    resolving, discarding, discardCandidate, otherOwnerOpen, otherOwnerSearch,
    otherOwnerOptions, otherOwnerLoading, selectedOtherOwner, editNameOpen, editedName,
    mergeOpen, replacementDialog, replacementMainNames, replacementValidationStatus,
    replacementValidationErrors, editSourceName, editSourceType, editInspection, editInspectionPending,
    focusAfterRefresh
  } = controller

  useEffect(() => {
    if (focusAfterRefresh === undefined) return
    const target = focusAfterRefresh
      ? groupButtonRefs.current.get(focusAfterRefresh)
      : completeButtonRef.current ?? backButtonRef.current
    target?.focus()
    controller.focusHandled()
  }, [controller, focusAfterRefresh])

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
            onClick={() => controller.chooseGroup(group)}
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
                  onChange={controller.selectTab}
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
                              onClick={() => controller.selectOwner({
                                actressId: owner.actressId,
                                revision: owner.revision,
                                mainName: owner.mainName
                              })}
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
                            onClick={controller.openOtherOwner}
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
                            onClick={() => controller.selectSource({ kind: 'scrape', id: candidate.pendingId })}
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
                              onClick={() => controller.selectSource({ kind: 'claim', id: claim.claimId })}
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
                      <button type="button" className="btn btn-sm btn-ghost" disabled={resolving} onClick={() => controller.requestDiscard(selectedCandidate)}>
                        <Trash2 {...UI_ICON_SM} aria-hidden />
                        {selectedGroup.status === 'applicable' ? '丢弃这份结果' : '丢弃这份错误匹配'}
                      </button>
                    ) : null}
                    {selectedGroup.status === 'applicable' ? (
                      <button type="button" className="btn btn-sm btn-primary" disabled={resolving || !selectedCandidate} onClick={controller.applySelectedPending}>
                        应用待确认资料
                      </button>
                    ) : (
                      <button type="button" className="btn btn-sm btn-primary" disabled={resolving || !proposedOwner} onClick={controller.confirmOwnership}>
                        {resolving ? '处理中…' : '确认名称归属'}
                      </button>
                    )}
                  </div>
                </footer>

                {selectedGroup.status === 'conflict' ? (
                  <div className="conflict-workbench-secondary-actions" aria-label="其他处理方式">
                    <span>其他处理</span>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={!editSourceName || resolving} onClick={controller.openEditName}>
                      <Pencil {...UI_ICON_SM} aria-hidden />修改本条返回名称
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={mergeActors.length < 2 || resolving} onClick={controller.openMerge}>
                      <GitMerge {...UI_ICON_SM} aria-hidden />合并演员档案
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost conflict-workbench-illegal" disabled={resolving} onClick={controller.openIllegalName}>
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
          onCancel={controller.closeOtherOwner}
        >
          <p>这里只选择拟定归属；不会在弹窗内提交名称变更。</p>
          <div className="conflict-workbench-owner-picker">
            <input
              type="search"
              className="search-input form-control-full"
              placeholder="搜索演员主名或别名…"
              value={otherOwnerSearch}
              onChange={(event) => controller.changeOtherOwnerSearch(event.target.value)}
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
                  onClick={() => void controller.chooseOtherOwner(item)}
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
          onConfirm={controller.submitEditedName}
          onCancel={controller.closeEditName}
        >
          <dl className="conflict-workbench-edit-context">
            <div><dt>当前名称</dt><dd className="copyable-text">{editSourceName}</dd></div>
            <div><dt>名称类型</dt><dd>{NAME_TYPE_LABEL[editSourceType]}</dd></div>
            <div><dt>来源</dt><dd>{selectedCandidate ? `${selectedCandidate.plugin.name} · ${selectedCandidate.actressMainName}` : '历史名称声明'}</dd></div>
            <div><dt>作用范围</dt><dd>{CONFLICT_ACTION_SCOPE_LABEL.editName}</dd></div>
          </dl>
          <label className="conflict-workbench-edit-field">
            <span>新名称</span>
            <input autoFocus className="text-input form-control-full" value={editedName} onChange={(event) => controller.changeEditedName(event.target.value)} />
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
          onConfirm={replacementDialog === 'illegal' ? controller.submitIllegalName : controller.submitOwnership}
          onCancel={controller.closeReplacement}
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
                  onChange={(event) => controller.changeReplacementMainName(claimant.actressId, event.target.value)}
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
          onConfirm={controller.submitMerge}
          onCancel={controller.closeMerge}
        />
      ) : null}

      {discardCandidate ? (
        <ConfirmModal
          title={selectedGroup?.status === 'applicable' ? '丢弃这份结果' : '丢弃这份错误匹配'}
          danger
          confirmText={discarding ? '丢弃中…' : '确认丢弃'}
          busy={discarding}
          closeDisabled={discarding}
          onConfirm={() => void controller.discard()}
          onCancel={controller.cancelDiscard}
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
