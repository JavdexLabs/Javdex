import { useMemo, useState } from 'react'
import { resolveMediaSrc } from '../api'
import ActressAvatar from '../components/ActressAvatar'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import {
  canConfirmMergeActresses,
  type ActressConflictMergeActor
} from './actressConflictReviewState'

export interface ConflictMergeActressesDecision {
  keepActressId: number
  keepActressRevision: number
  mergeActressId: number
  mergeActressRevision: number
  finalMainName: string
}

interface Props {
  actors: ActressConflictMergeActor[]
  busy: boolean
  onConfirm: (decision: ConflictMergeActressesDecision) => void
  onCancel: () => void
}

function ActorChoice({
  actor,
  detail
}: {
  actor: ActressConflictMergeActor
  detail: string
}): JSX.Element {
  return (
    <span className="conflict-merge-actor-copy">
      <ActressAvatar
        src={resolveMediaSrc(actor.avatarPath)}
        name={actor.mainName}
        gender={null}
        decorative
      />
      <span>
        <strong>{actor.mainName}</strong>
        <small>{detail}</small>
      </span>
    </span>
  )
}

export default function ConflictMergeActressesModal({
  actors,
  busy,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<number[]>(
    actors.length === 2 ? actors.map((actor) => actor.actressId) : []
  )
  const [keepActressId, setKeepActressId] = useState<number | null>(null)
  const [finalMainNameActressId, setFinalMainNameActressId] = useState<number | null>(null)
  const pair = useMemo(
    () => selectedIds.flatMap((id) => actors.find((actor) => actor.actressId === id) ?? []),
    [actors, selectedIds]
  )
  const bothHavePending = pair.length === 2 && pair.every((actor) => actor.hasPending)
  const pairBlockedReason =
    pair.length === 2
      ? pair[0].blockedPartnerReasons[pair[1].actressId] ?? null
      : null
  const hasThirdPartyConflict = actors.length > 2 || Boolean(pairBlockedReason)
  const confirmEnabled = canConfirmMergeActresses(
    actors,
    pair[0]?.actressId ?? -1,
    pair[1]?.actressId ?? null,
    keepActressId,
    finalMainNameActressId
  )

  const toggleActor = (actressId: number): void => {
    setSelectedIds((current) => {
      const next = current.includes(actressId)
        ? current.filter((id) => id !== actressId)
        : current.length < 2
          ? [...current, actressId]
          : [current[1], actressId]
      return next
    })
    setKeepActressId(null)
    setFinalMainNameActressId(null)
  }

  const confirm = (): void => {
    if (!confirmEnabled) return
    const keeper = pair.find((actor) => actor.actressId === keepActressId)
    const merged = pair.find((actor) => actor.actressId !== keepActressId)
    const finalNameActor = pair.find((actor) => actor.actressId === finalMainNameActressId)
    if (!keeper || !merged || !finalNameActor) return
    onConfirm({
      keepActressId: keeper.actressId,
      keepActressRevision: keeper.revision,
      mergeActressId: merged.actressId,
      mergeActressRevision: merged.revision,
      finalMainName: finalNameActor.mainName
    })
  }

  return (
    <ConfirmModal
      title="合并演员档案"
      size="md"
      danger
      confirmText={busy ? '合并中…' : '确认合并'}
      confirmDisabled={!confirmEnabled || busy}
      busy={busy}
      closeDisabled={busy}
      onConfirm={confirm}
      onCancel={onCancel}
    >
      <p>合并会删除其中一条档案。请依次选择两位演员、保留档案和最终主名。</p>

      <fieldset className="conflict-merge-fieldset">
        <legend>1. 选择两位演员</legend>
        <div className="conflict-merge-options">
          {actors.map((actor) => {
            const selected = selectedIds.includes(actor.actressId)
            return (
              <label
                key={actor.actressId}
                className={`conflict-merge-option${selected ? ' is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={busy}
                  onChange={() => toggleActor(actor.actressId)}
                />
                <ActorChoice
                  actor={actor}
                  detail={actor.hasPending ? '有关联待确认刮削结果' : '仅演员档案与名称'}
                />
              </label>
            )
          })}
          {actors.length < 2 ? (
            <EmptyState variant="modal" title="当前组没有两条可合并档案" />
          ) : null}
        </div>
        {bothHavePending ? (
          <p className="text-danger">两位演员都有待确认刮削结果，请先处理其中一份。</p>
        ) : null}
        {hasThirdPartyConflict ? (
          <p className="text-danger">
            {actors.length > 2
              ? '本组还涉及第三位演员，请先确认名称归属后再合并。'
              : pairBlockedReason}
          </p>
        ) : null}
      </fieldset>

      {pair.length === 2 ? (
        <>
          <fieldset className="conflict-merge-fieldset">
            <legend>2. 选择保留档案</legend>
            <div className="conflict-merge-options conflict-merge-options--two">
              {pair.map((actor) => (
                <label
                  key={actor.actressId}
                  className={`conflict-merge-option${
                    keepActressId === actor.actressId ? ' is-selected' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="conflict-merge-keeper"
                    checked={keepActressId === actor.actressId}
                    disabled={busy || bothHavePending || hasThirdPartyConflict}
                    onChange={() => setKeepActressId(actor.actressId)}
                  />
                  <ActorChoice actor={actor} detail="保留这条档案及已有资料" />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="conflict-merge-fieldset">
            <legend>3. 选择最终主名</legend>
            <div className="conflict-merge-name-options">
              {pair.map((actor) => (
                <label
                  key={`${actor.actressId}-${actor.mainName}`}
                  className={finalMainNameActressId === actor.actressId ? 'is-selected' : ''}
                >
                  <input
                    type="radio"
                    name="conflict-merge-main-name"
                    checked={finalMainNameActressId === actor.actressId}
                    disabled={busy || bothHavePending || hasThirdPartyConflict}
                    onChange={() => setFinalMainNameActressId(actor.actressId)}
                  />
                  <span>{actor.mainName}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : null}
    </ConfirmModal>
  )
}
