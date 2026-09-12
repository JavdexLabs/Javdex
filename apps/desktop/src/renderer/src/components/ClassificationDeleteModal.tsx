import type {
  DirectorDeleteImpact,
  DirectorDeleteResult,
  SeriesDeleteImpact,
  SeriesDeleteResult
} from '@shared/classificationTypes'
import { usePreviewCommand } from '../hooks/usePreviewCommand'
import Modal from './Modal'

type DeleteImpact = DirectorDeleteImpact | SeriesDeleteImpact
type DeleteResult = DirectorDeleteResult | SeriesDeleteResult

interface Props<TImpact extends DeleteImpact, TResult extends DeleteResult> {
  entityLabel: '导演' | '系列'
  entityName: string
  loadImpact: () => Promise<TImpact>
  remove: () => Promise<TResult>
  onCancel: () => void
  onDeleted: (result: TResult) => void | Promise<void>
}

function directChildCount(impact: DeleteImpact): number {
  return 'directChildCount' in impact ? impact.directChildCount : 0
}

export default function ClassificationDeleteModal<
  TImpact extends DeleteImpact,
  TResult extends DeleteResult
>({
  entityLabel,
  entityName,
  loadImpact,
  remove,
  onCancel,
  onDeleted
}: Props<TImpact, TResult>): JSX.Element {
  const { impact, error, running: deleting, execute } = usePreviewCommand({
    loadImpact,
    command: remove,
    onCompleted: onDeleted,
    completionErrorMessage: `已删除${entityLabel}，但页面收尾失败`
  })

  const children = impact ? directChildCount(impact) : 0
  return (
    <Modal
      title={`删除${entityLabel}`}
      danger
      busy={deleting}
      closeDisabled={deleting}
      confirmText={deleting ? '删除中…' : `删除${entityLabel}`}
      confirmDisabled={!impact}
      onCancel={onCancel}
      onConfirm={() => void execute()}
    >
      <div className="classification-delete-confirmation selectable-text">
        {!impact && !error ? <p>正在检查影响范围…</p> : null}
        {impact ? (
          <>
            <p>
              确定删除{entityLabel}“{entityName}”？将解除 {impact.videoCount} 部影片的
              {entityLabel}关联
              {entityLabel === '系列' ? `，并让 ${children} 个直接子系列变为无上级` : ''}。
            </p>
            <p className="classification-delete-confirmation__safe">
              影片、影片资源及其他影片元数据不会被删除。{entityLabel}资料与正式主图将被永久移除。
            </p>
          </>
        ) : null}
        {error ? <p className="classification-maintenance-error">{error}</p> : null}
      </div>
    </Modal>
  )
}
