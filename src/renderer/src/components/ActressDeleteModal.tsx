import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActressDeleteImpact, ActressDeleteResult } from '@shared/actressIpcContract'
import { api } from '../api'
import Modal from './Modal'
import {
  actressDeleteConfirmationCopy,
  actressDeleteModeForAction,
  type ActressDeleteConfirmationAction
} from './actressDeleteConfirmation'
import Button from './Button'

interface ActressDeleteModalProps {
  ids: number[]
  subjectLabel: string
  onCancel: () => void
  onDeleted: (result: ActressDeleteResult) => void
}

export default function ActressDeleteModal({
  ids,
  subjectLabel,
  onCancel,
  onDeleted
}: ActressDeleteModalProps): JSX.Element {
  const [impact, setImpact] = useState<ActressDeleteImpact | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const requestSequence = useRef(0)
  const idsKey = ids.join(',')
  const requestIds = useMemo(
    () => idsKey.split(',').map(Number).filter((id) => Number.isInteger(id) && id > 0),
    [idsKey]
  )

  const loadImpact = useCallback(async (clearError = true): Promise<void> => {
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setImpact(null)
    if (clearError) setError(null)
    try {
      const nextImpact = await api.actresses.deletePreview(requestIds)
      if (requestSequence.current === sequence) setImpact(nextImpact)
    } catch (loadError) {
      if (requestSequence.current === sequence) {
        setError(String((loadError as Error).message ?? loadError))
      }
    }
  }, [requestIds])

  useEffect(() => {
    void loadImpact()
  }, [loadImpact])

  const execute = async (action: ActressDeleteConfirmationAction): Promise<void> => {
    if (!impact || deleting) return
    const mode = actressDeleteModeForAction(impact, action)
    if (!mode) return
    setDeleting(true)
    setError(null)
    try {
      const result = requestIds.length === 1
        ? await api.actresses.remove(requestIds[0], mode)
        : await api.actresses.removeBatch(requestIds, mode)
      onDeleted(result)
    } catch (deleteError) {
      setError(String((deleteError as Error).message ?? deleteError))
      await loadImpact(false)
    } finally {
      setDeleting(false)
    }
  }

  const copy = impact ? actressDeleteConfirmationCopy(impact, subjectLabel) : null

  return (
    <Modal
      title={requestIds.length === 1 ? '删除演员' : '批量删除演员'}
      danger
      busy={deleting}
      closeDisabled={deleting}
      onCancel={onCancel}
      actions={
        <>
          <Button type="button" disabled={deleting} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!impact || deleting}
            onClick={() =>
              void execute(copy?.highRisk ? 'acknowledge-risk' : 'ordinary-confirm')
            }
          >
            {deleting ? '删除中…' : copy?.confirmText ?? '删除'}
          </Button>
        </>
      }
    >
      <div className="actress-delete-confirmation selectable-text">
        {!impact && !error ? <p>正在检查影片关联…</p> : null}
        {copy ? <p>{copy.description}</p> : null}
        {copy?.highRisk ? (
          <p className="actress-delete-confirmation__warning">
            不建议删除有关联演员：保留演员档案与名称别名，可以让后续刮削继续关联到正确演员。
          </p>
        ) : null}
        {error ? <p className="actress-delete-confirmation__error">{error}</p> : null}
      </div>
    </Modal>
  )
}
