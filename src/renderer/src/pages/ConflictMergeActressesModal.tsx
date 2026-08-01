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
  selectedActressId: number
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
  selectedActressId,
  busy,
  onConfirm,
  onCancel
}: Props): JSX.Element {
  const selectedActor = actors.find((actor) => actor.actressId === selectedActressId) ?? null
  const partnerOptions = actors.filter((actor) => actor.actressId !== selectedActressId)
  const [partnerActressId, setPartnerActressId] = useState<number | null>(null)
  const [keepActressId, setKeepActressId] = useState<number | null>(null)
  const [finalMainNameActressId, setFinalMainNameActressId] = useState<number | null>(null)
  const partnerActor =
    actors.find((actor) => actor.actressId === partnerActressId) ?? null
  const pair = useMemo(
    () => (selectedActor && partnerActor ? [selectedActor, partnerActor] : []),
    [partnerActor, selectedActor]
  )
  const confirmEnabled = canConfirmMergeActresses(
    actors,
    selectedActressId,
    partnerActressId,
    keepActressId,
    finalMainNameActressId
  )

  const choosePartner = (actressId: number): void => {
    setPartnerActressId(actressId)
    setKeepActressId(null)
    setFinalMainNameActressId(null)
  }

  const confirm = (): void => {
    if (!confirmEnabled || !selectedActor || !partnerActor || keepActressId == null) return
    const keeper = keepActressId === selectedActor.actressId ? selectedActor : partnerActor
    const merged = keepActressId === selectedActor.actressId ? partnerActor : selectedActor
    const finalMainName = pair.find(
      (actor) => actor.actressId === finalMainNameActressId
    )?.mainName
    if (!finalMainName) return
    onConfirm({
      keepActressId: keeper.actressId,
      keepActressRevision: keeper.revision,
      mergeActressId: merged.actressId,
      mergeActressRevision: merged.revision,
      finalMainName
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
      <p>
        合并会删除其中一条档案，并把影片、写真、标签、名称和缺失资料收敛到保留档案。请逐项明确选择，系统不会自动决定。
      </p>
      {selectedActor ? (
        <div className="conflict-merge-selected">
          <span>当前待确认演员</span>
          <ActorChoice actor={selectedActor} detail="已有待确认刮削结果" />
        </div>
      ) : null}

      <fieldset className="conflict-merge-fieldset">
        <legend>选择另一条演员档案</legend>
        <div className="conflict-merge-options">
          {partnerOptions.map((actor, index) => {
            const blocked = actor.hasPending
            const disabled = busy || blocked
            return (
              <label
                key={actor.actressId}
                className={`conflict-merge-option${
                  partnerActressId === actor.actressId ? ' is-selected' : ''
                }${disabled ? ' is-disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="conflict-merge-partner"
                  checked={partnerActressId === actor.actressId}
                  disabled={disabled}
                  autoFocus={index === 0 && !disabled}
                  onChange={() => choosePartner(actor.actressId)}
                />
                <ActorChoice
                  actor={actor}
                  detail={blocked ? '也有待确认结果，请先处理其中一份' : '可与当前演员合并'}
                />
              </label>
            )
          })}
          {partnerOptions.length === 0 ? (
            <EmptyState
              variant="modal"
              title="当前组没有另一条可合并档案"
            />
          ) : null}
        </div>
      </fieldset>

      {pair.length === 2 ? (
        <>
          <fieldset className="conflict-merge-fieldset">
            <legend>选择保留演员</legend>
            <div className="conflict-merge-options conflict-merge-options--two">
              {pair.map((actor) => (
                <label
                  key={actor.actressId}
                  className={`conflict-merge-option${
                    keepActressId === actor.actressId ? ' is-selected' : ''
                  }${busy ? ' is-disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="conflict-merge-keeper"
                    checked={keepActressId === actor.actressId}
                    disabled={busy}
                    onChange={() => setKeepActressId(actor.actressId)}
                  />
                  <ActorChoice actor={actor} detail="保留这条档案及已有资料" />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="conflict-merge-fieldset">
            <legend>选择最终主名</legend>
            <div className="conflict-merge-name-options">
              {pair.map((actor) => (
                <label
                  key={`${actor.actressId}-${actor.mainName}`}
                  className={
                    `${finalMainNameActressId === actor.actressId ? 'is-selected' : ''}${
                      busy ? ' is-disabled' : ''
                    }`.trim()
                  }
                >
                  <input
                    type="radio"
                    name="conflict-merge-main-name"
                    checked={finalMainNameActressId === actor.actressId}
                    disabled={busy}
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
