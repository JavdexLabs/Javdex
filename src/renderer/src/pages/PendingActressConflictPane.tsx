import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Ban, CircleAlert, GitMerge, Pencil, SquareArrowOutUpRight, Trash2, UserRoundSearch } from 'lucide-react'
import type {
  ActressPendingNameType,
  PendingActressNameClaim,
  PendingActressScrapeCandidate
} from '@shared/actressConflictTypes'
import type {
  ActressScrapeField,
  ActressScrapeFieldImpact,
  ActressScrapeUpdateMode
} from '@shared/actressScrapeTypes'
import { ACTRESS_SCRAPE_FIELD_OPTIONS } from '@shared/actressScrapeTypes'
import { resolveMediaSrc } from '../api'
import ActressAvatar from '../components/ActressAvatar'
import Button from '../components/Button'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import IconButton from '../components/IconButton'
import { UI_ICON_SM } from '../components/iconDefaults'
import { WorkbenchTabs } from '../components/workbench'
import { navigateToActressDetail } from '../listView/listNavigation'
import ConflictMergeActressesModal from './ConflictMergeActressesModal'
import {
  CONFLICT_ACTION_SCOPE_LABEL,
  conflictFieldImpactsForProposedOwner,
  partitionConflictFieldImpacts
} from './actressConflictReviewState'
import {
  PendingAlert,
  PendingConfirmBar,
  PendingImpactCard,
  PendingImpactCards,
  PendingImpactList,
  PendingImpactNote,
  PendingImpactRow,
  PendingSecondaryActions,
  PendingStep,
  PendingUnchangedImpacts,
  PendingUnchangedRow,
  PendingWorkspace,
  PendingWorkspacePanel
} from './PendingDecisionParts'
import type { ConflictReviewViewModel } from './useConflictReviewController'
import styles from './PendingActressConflictPane.module.css'

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

function OwnerChoiceCard({
  selected,
  name,
  hint,
  avatarSrc,
  gender = null,
  actressId,
  className,
  extraAction,
  onSelect
}: {
  selected: boolean
  name: string
  hint: string
  avatarSrc: string | null | undefined
  gender?: 'female' | 'male' | null
  actressId: number
  className?: string
  extraAction?: ReactNode
  onSelect: () => void
}): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <div
      className={`conflict-workbench-owner${selected ? ' is-selected' : ''}${className ? ` ${className}` : ''}`}
    >
      <label className={styles.ownerSelect}>
        <input
          className={styles.ownerRadio}
          type="radio"
          name="pending-actress-owner"
          checked={selected}
          onChange={onSelect}
        />
        <ActressAvatar
          src={resolveMediaSrc(avatarSrc)}
          name={name}
          gender={gender}
          decorative
        />
        <span className={styles.ownerCopy}>
          <strong>{name}</strong>
          <small>{hint}</small>
        </span>
      </label>
      <div className={styles.ownerActions}>
        {extraAction}
        <IconButton
          size="sm"
          icon={<SquareArrowOutUpRight {...UI_ICON_SM} aria-hidden />}
          label={`查看「${name}」的详情`}
          onClick={() => navigateToActressDetail(navigate, location, actressId)}
        />
      </div>
    </div>
  )
}

function impactFieldLabel(impact: ActressScrapeFieldImpact): string {
  if (impact.part) return IMPACT_PART_LABEL[impact.part]
  return FIELD_LABEL.get(impact.field) ?? impact.field
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
      <PendingImpactNote>
        处理本组后仍有 {candidate.remainingConflictCountAfterDecision} 个名称冲突，资料暂不写入。
      </PendingImpactNote>
    )
  }
  const { changed, unchanged, unchangedInitiallyOpen } = partitionConflictFieldImpacts(impacts)
  return (
    <PendingImpactList>
      {changed.length === 0 ? (
        <PendingImpactNote>没有资料字段会发生变化。</PendingImpactNote>
      ) : (
        changed.map((impact, index) => (
          <PendingImpactRow
            key={`${impact.field}-${impact.part ?? 'field'}-${index}`}
            label={impactFieldLabel(impact)}
            current={formatImpactValue(impact.currentValue)}
            next={formatImpactValue(impact.nextValue)}
            action={IMPACT_ACTION_LABEL[impact.action]}
            clearing={impact.action === 'clear'}
          />
        ))
      )}
      {unchanged.length > 0 ? (
        <PendingUnchangedImpacts summary={`${unchanged.length} 项保持不变`} open={unchangedInitiallyOpen}>
          {unchanged.map((impact, index) => (
            <PendingUnchangedRow
              key={`${impact.field}-${impact.part ?? 'field'}-${index}`}
              label={impactFieldLabel(impact)}
              value={formatImpactValue(impact.currentValue)}
              reason={IMPACT_PRESERVE_REASON_LABEL[impact.reason]}
            />
          ))}
        </PendingUnchangedImpacts>
      ) : null}
    </PendingImpactList>
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
          <PendingImpactNote>插件没有返回非空资料字段。</PendingImpactNote>
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

export default function PendingActressConflictPane({
  vm
}: {
  vm: ConflictReviewViewModel
}): JSX.Element {
  const { queue, detail, dialogs, busy } = vm
  const { selectedGroup, staleMessage } = queue
  const {
    selection,
    selectedCandidate,
    selectedClaim,
    ownerOptions,
    mergeActors,
    proposedOwner,
    editSourceName,
    editSourceType,
    editInspection,
    editInspectionPending
  } = detail
  const { resolving } = busy
  const { otherOwner, editName, merge, replacement, discard } = dialogs

  if (!selectedGroup || !selection) {
    return <EmptyState title="请选择名称组" variant="fill" />
  }

  const isConflict = selectedGroup.status === 'conflict'
  const unlockableCount = selectedGroup.candidates.filter(
    (candidate) => candidate.willApplyAfterDecision
  ).length

  const overlays = (
    <>
      {otherOwner.open ? (
        <ConfirmModal
          title="选择其他演员"
          size="md"
          className="modal--conflict-owner-picker"
          bodyClassName="conflict-workbench-owner-modal-body"
          confirmText="选好后返回处理页确认"
          confirmDisabled
          onConfirm={() => undefined}
          onCancel={otherOwner.close}
        >
          <p>这里只选择拟定归属；不会在弹窗内提交名称变更。</p>
          <div className="conflict-workbench-owner-picker">
            <input
              type="search"
              className="search-input form-control-full"
              placeholder="搜索演员主名或别名…"
              value={otherOwner.search}
              onChange={(event) => otherOwner.changeSearch(event.target.value)}
            />
            <div className="conflict-workbench-owner-search" role="group" aria-label="其他演员">
              {otherOwner.loading ? (
                <EmptyState loading variant="modal" />
              ) : otherOwner.options.length === 0 ? (
                <EmptyState title="没有匹配的演员" variant="modal" />
              ) : (
                otherOwner.options.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={otherOwner.selected?.id === item.id}
                    className={otherOwner.selected?.id === item.id ? 'is-selected' : ''}
                    onClick={() => otherOwner.choose(item)}
                  >
                    <ActressAvatar
                      src={resolveMediaSrc(item.avatar_path)}
                      name={item.main_name}
                      gender={item.gender}
                      decorative
                    />
                    <span><strong>{item.main_name}</strong><small>{item.video_count} 部影片</small></span>
                  </button>
                ))
              )}
            </div>
          </div>
        </ConfirmModal>
      ) : null}

      {editName.open && selectedGroup && editSourceType ? (
        <ConfirmModal
          title="修改本条返回名称"
          size="sm"
          confirmText={resolving ? '处理中…' : '确认修改'}
          confirmDisabled={
            !editName.canSubmit ||
            editInspectionPending ||
            editInspection.status === 'empty' ||
            editInspection.status === 'unchanged'
          }
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={editName.submit}
          onCancel={editName.close}
        >
          <dl className="conflict-workbench-edit-context">
            <div><dt>当前名称</dt><dd className="copyable-text">{editSourceName}</dd></div>
            <div><dt>名称类型</dt><dd>{NAME_TYPE_LABEL[editSourceType]}</dd></div>
            <div>
              <dt>来源</dt>
              <dd>
                {selectedCandidate
                  ? `${selectedCandidate.plugin.name} · ${selectedCandidate.actressMainName}`
                  : '历史名称声明'}
              </dd>
            </div>
            <div><dt>作用范围</dt><dd>{CONFLICT_ACTION_SCOPE_LABEL.editName}</dd></div>
          </dl>
          <label className="conflict-workbench-edit-field">
            <span>新名称</span>
            <input
              autoFocus
              className="text-input form-control-full"
              value={editName.value}
              onChange={(event) => editName.change(event.target.value)}
            />
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

      {replacement.kind && selectedGroup ? (
        <ConfirmModal
          title={
            replacement.kind === 'illegal'
              ? `从本组删除「${selectedGroup.displayName}」`
              : `确认归属给「${proposedOwner?.mainName ?? ''}」`
          }
          size="sm"
          danger={replacement.kind === 'illegal'}
          confirmText={
            resolving ? '处理中…' : replacement.kind === 'illegal' ? '确认从本组删除' : '确认名称归属'
          }
          confirmDisabled={!replacement.canSubmit}
          busy={resolving}
          closeDisabled={resolving}
          onConfirm={replacement.submit}
          onCancel={replacement.close}
        >
          {replacement.kind === 'illegal' ? (
            <div>
              <p>这会删除该名称的现有归属和全部相关名称声明，并从本组所有待确认结果中排除该名称。</p>
              <p>其他有效资料继续写回原目标演员；不会保存黑名单、错误记录或长期规则。</p>
            </div>
          ) : (
            <p>该名称当前是下列演员的主名。转移归属前，请为每位演员指定替代主名；所有更改将通过同一事务提交。</p>
          )}
          {replacement.claimants.map((claimant, index) => {
            const error = replacement.errors[claimant.actressId]
            const errorId = `conflict-replacement-error-${claimant.actressId}`
            return (
              <label className="conflict-workbench-edit-field" key={claimant.actressId}>
                <span>为「{claimant.mainName}」填写替代主名</span>
                <input
                  autoFocus={index === 0}
                  className="text-input form-control-full"
                  value={replacement.mainNames[claimant.actressId] ?? ''}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => replacement.change(claimant.actressId, event.target.value)}
                />
                {error ? <small id={errorId} className="text-danger">{error}</small> : null}
              </label>
            )
          })}
          {replacement.claimants.length > 0 && replacement.status === 'checking' ? (
            <p role="status">正在检查替代主名…</p>
          ) : null}
        </ConfirmModal>
      ) : null}

      {merge.open && selectedGroup ? (
        <ConflictMergeActressesModal
          key={selectedGroup.normalizedName}
          actors={merge.actors}
          busy={resolving}
          onConfirm={merge.submit}
          onCancel={merge.close}
        />
      ) : null}

      {discard.candidate ? (
        <ConfirmModal
          title={selectedGroup?.status === 'applicable' ? '丢弃这份结果' : '丢弃这份错误匹配'}
          danger
          confirmText={discard.busy ? '丢弃中…' : '确认丢弃'}
          busy={discard.busy}
          closeDisabled={discard.busy}
          onConfirm={discard.confirm}
          onCancel={discard.cancel}
        >
          <p>
            确认丢弃「{discard.candidate.actressMainName}」的
            {selectedGroup?.status === 'applicable' ? '待确认资料' : '整份刮削结果'}吗？
          </p>
          <p>作用范围：{CONFLICT_ACTION_SCOPE_LABEL.discardScrape}</p>
          <p>不会改变名称归属、历史声明或同组其他结果；该结果的暂存资源会被清理，并记录本次刮削失败。</p>
        </ConfirmModal>
      ) : null}
    </>
  )

  return (
    <PendingWorkspace
      eyebrow={isConflict ? '演员名称冲突' : '资料等待应用'}
      title={
        isConflict
          ? `「${selectedGroup.displayName}」应该属于哪位演员？`
          : `「${selectedGroup.displayName}」的冲突已消失`
      }
      description={
        isConflict
          ? selectedCandidate
            ? `${selectedCandidate.plugin.name} 为「${selectedCandidate.actressMainName}」返回了名称「${selectedGroup.displayName}」；当前该名称归属于「${selectedGroup.currentOwner?.mainName ?? '暂无演员'}」，请结合来源资料确认。`
            : '多位演员保存了同一个名称，请确认最终归属，或选择其他处理方式。'
          : '名称冲突已消失，资料仍未写入。请选择来源查看影响后明确应用或丢弃。'
      }
      status={isConflict ? '待确认' : '可应用'}
      statusTone={isConflict ? 'waiting' : 'ok'}
      alert={
        staleMessage ? (
          <PendingAlert inline>
            <CircleAlert {...UI_ICON_SM} aria-hidden />
            {staleMessage}
          </PendingAlert>
        ) : null
      }
      tabs={
        <WorkbenchTabs
          id="actress-conflict-tab"
          label="冲突工作区"
          value={selection.tab}
          items={[
            { id: 'process', label: '处理', panelId: 'actress-conflict-panel-process' },
            { id: 'source', label: '来源详情', panelId: 'actress-conflict-panel-source' }
          ]}
          onChange={detail.selectTab}
        />
      }
      confirm={
        <PendingConfirmBar
          summary={
            isConflict
              ? proposedOwner
                ? `拟定归属：${proposedOwner.mainName}`
                : '尚未选择名称归属'
              : selectedCandidate
                ? `资料将写回「${selectedCandidate.actressMainName}」`
                : '请选择一份待确认资料'
          }
          scope={CONFLICT_ACTION_SCOPE_LABEL[isConflict ? 'assignOwnership' : 'applyPending']}
        >
          {selectedCandidate ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={resolving}
              onClick={() => detail.requestDiscard(selectedCandidate)}
            >
              <Trash2 {...UI_ICON_SM} aria-hidden />
              {isConflict ? '丢弃这份错误匹配' : '丢弃这份结果'}
            </Button>
          ) : null}
          {isConflict ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resolving || !proposedOwner}
              onClick={detail.confirmOwnership}
            >
              {resolving ? '处理中…' : '确认名称归属'}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={resolving || !selectedCandidate}
              onClick={detail.applySelectedPending}
            >
              应用待确认资料
            </Button>
          )}
        </PendingConfirmBar>
      }
      secondary={
        isConflict ? (
          <PendingSecondaryActions>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!editSourceName || resolving}
              onClick={detail.openEditName}
            >
              <Pencil {...UI_ICON_SM} aria-hidden />修改本条返回名称
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={mergeActors.length < 2 || resolving}
              onClick={detail.openMerge}
            >
              <GitMerge {...UI_ICON_SM} aria-hidden />合并演员档案
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="conflict-workbench-illegal"
              disabled={resolving}
              onClick={detail.openIllegalName}
            >
              <Ban {...UI_ICON_SM} aria-hidden />这不是演员名称
            </Button>
          </PendingSecondaryActions>
        ) : null
      }
      overlays={overlays}
    >
      <PendingWorkspacePanel
        id="actress-conflict-panel-process"
        labelledBy="actress-conflict-tab-process"
        hidden={selection.tab !== 'process'}
      >
        {isConflict ? (
          <PendingStep
            step={1}
            title="选择名称归属"
            hint="点选拟定归属；详情可打开演员页核对"
          >
            <div className="conflict-workbench-owner-grid" role="radiogroup" aria-label="名称归属">
              {ownerOptions.map((owner) => (
                <OwnerChoiceCard
                  key={owner.actressId}
                  selected={proposedOwner?.actressId === owner.actressId}
                  name={owner.mainName}
                  hint={owner.roles.join(' · ')}
                  avatarSrc={owner.avatarPath}
                  actressId={owner.actressId}
                  onSelect={() =>
                    detail.selectOwner({
                      actressId: owner.actressId,
                      revision: owner.revision,
                      mainName: owner.mainName
                    })
                  }
                />
              ))}
              {otherOwner.selected ? (
                <OwnerChoiceCard
                  selected={proposedOwner?.actressId === otherOwner.selected.id}
                  className="conflict-workbench-owner--other"
                  name={otherOwner.selected.main_name}
                  hint="已从演员库选择"
                  avatarSrc={otherOwner.selected.avatar_path}
                  gender={otherOwner.selected.gender}
                  actressId={otherOwner.selected.id}
                  extraAction={
                    <IconButton
                      size="sm"
                      icon={<UserRoundSearch {...UI_ICON_SM} />}
                      label="重新选择演员"
                      onClick={detail.openOtherOwner}
                    />
                  }
                  onSelect={() => otherOwner.choose(otherOwner.selected!)}
                />
              ) : (
                <button
                  type="button"
                  className="conflict-workbench-owner conflict-workbench-owner--other"
                  onClick={detail.openOtherOwner}
                >
                  <UserRoundSearch {...UI_ICON_SM} aria-hidden />
                  <span>
                    <strong>选择其他演员…</strong>
                    <small>从演员库搜索组外演员</small>
                  </span>
                </button>
              )}
            </div>
          </PendingStep>
        ) : null}

        <PendingStep
          step={isConflict ? 2 : 1}
          title="选择冲突来源"
          hint="只影响详情、改名和错误匹配丢弃"
        >
          <div className="conflict-workbench-source-list" role="group" aria-label="冲突来源">
            {selectedGroup.candidates.map((candidate) => {
              const active =
                selection.source?.kind === 'scrape' && selection.source.id === candidate.pendingId
              return (
                <button
                  key={`scrape-${candidate.pendingId}`}
                  type="button"
                  aria-pressed={active}
                  className={active ? 'is-selected' : ''}
                  onClick={() => detail.selectSource({ kind: 'scrape', id: candidate.pendingId })}
                >
                  <ActressAvatar
                    src={resolveMediaSrc(candidate.actressAvatarPath)}
                    name={candidate.actressMainName}
                    gender={null}
                    decorative
                  />
                  <span>
                    <strong>{candidate.actressMainName}</strong>
                    <small>刮削结果 · {candidate.plugin.name} · {MODE_LABEL[candidate.mode]}</small>
                  </span>
                  <em>
                    {candidate.willApplyAfterDecision
                      ? '本次可解锁'
                      : `仍有 ${candidate.remainingConflictCountAfterDecision} 个冲突`}
                  </em>
                </button>
              )
            })}
            {selectedGroup.pendingNameClaims.map((claim) => {
              const claimant = selectedGroup.claimants.find(
                (item) => item.actressId === claim.actressId
              )
              const active =
                selection.source?.kind === 'claim' && selection.source.id === claim.claimId
              return (
                <button
                  key={`claim-${claim.claimId}`}
                  type="button"
                  aria-pressed={active}
                  className={active ? 'is-selected' : ''}
                  onClick={() => detail.selectSource({ kind: 'claim', id: claim.claimId })}
                >
                  <ActressAvatar
                    src={resolveMediaSrc(claimant?.avatarPath)}
                    name={claimant?.mainName ?? claim.name}
                    gender={null}
                    decorative
                  />
                  <span>
                    <strong>{claimant?.mainName ?? `演员 #${claim.actressId}`}</strong>
                    <small>历史声明 · {NAME_TYPE_LABEL[claim.type]}</small>
                  </span>
                  <em>当前来源</em>
                </button>
              )
            })}
          </div>
        </PendingStep>

        <PendingStep
          step={isConflict ? 3 : 2}
          title="查看确认后的影响"
          hint={`${unlockableCount} 份资料可在本次处理后应用`}
        >
          {isConflict && proposedOwner ? (
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
                        ? `；需将主名改为「${replacement.mainNames[claimant.actressId]?.trim() || '尚未设置'}」`
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
          ) : isConflict ? (
            <div className="conflict-workbench-impact-placeholder">
              先选择一位演员，才能确认名称归属影响。
            </div>
          ) : null}
          <PendingImpactCards>
            {selectedGroup.candidates.map((candidate) => (
              <PendingImpactCard
                key={candidate.pendingId}
                open={candidate.pendingId === selectedCandidate?.pendingId}
                title={`资料写回「${candidate.actressMainName}」`}
                note={candidate.willApplyAfterDecision ? '精确字段影响' : '继续等待'}
              >
                <ImpactRows
                  candidate={candidate}
                  impacts={conflictFieldImpactsForProposedOwner(candidate, proposedOwner)}
                />
              </PendingImpactCard>
            ))}
            {selectedGroup.candidates.length === 0 ? (
              <PendingImpactNote>这是历史名称归属，不包含刮削资料。</PendingImpactNote>
            ) : null}
          </PendingImpactCards>
        </PendingStep>
      </PendingWorkspacePanel>

      <PendingWorkspacePanel
        id="actress-conflict-panel-source"
        labelledBy="actress-conflict-tab-source"
        hidden={selection.tab !== 'source'}
      >
        <SourceDetails candidate={selectedCandidate} claim={selectedClaim} />
      </PendingWorkspacePanel>
    </PendingWorkspace>
  )
}
