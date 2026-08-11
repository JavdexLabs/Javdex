import Modal from './Modal'
import type { ActressFaceScanProgress, ActressFaceScanSummary } from '../actressFaceFilter/scanQueue'
import Button from './Button'

interface Props {
  progress: ActressFaceScanProgress
  summary: ActressFaceScanSummary | null
  onCancel: () => void
  onDone: () => void
}

export default function ActressFaceScanModal({
  progress,
  summary,
  onCancel,
  onDone
}: Props): JSX.Element {
  const running = progress.status === 'running' || progress.status === 'cancelling'
  const cancelling = progress.status === 'cancelling'
  const completed = progress.status === 'done'
  const title = completed ? '人脸识别完成' : '正在识别人脸'
  const hint = completed
    ? summary?.cancelled
      ? '扫描已取消，未应用本次不完整的筛选结果。'
      : summary?.total === 0 && summary.failed > 0
        ? `人脸识别失败：${summary.failures[0]?.message ?? '无法读取头像'}`
        : `找到 ${summary?.withoutFace ?? 0} 位头像未识别到人脸的演员。`
    : '正在使用本地模型检查所有可用演员头像。'

  return (
    <Modal
      title={title}
      hint={hint}

      size="sm"
      dismissible={false}
      onCancel={onDone}
      actions={
        running ? (
          <Button
            type="button"
            variant="ghost"
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? '正在取消…' : '取消扫描'}
          </Button>
        ) : (
          <Button type="button" variant="primary" onClick={onDone}>
            完成
          </Button>
        )
      }
    >
      <div className="actress-face-scan-progress" aria-live="polite">
        <progress
          max={Math.max(1, progress.total)}
          value={Math.min(progress.current, progress.total)}
          aria-label="人脸识别进度"
        />
        <div className="actress-face-scan-progress-meta">
          <span>
            已处理 {progress.current}/{progress.total}
          </span>
          <span>复用 {progress.reused}</span>
        </div>
        <div className="actress-face-scan-stats">
          <span>有脸 {progress.hasFace}</span>
          <span>无人脸 {progress.withoutFace}</span>
          <span>识别失败 {progress.failed}</span>
        </div>
        {progress.currentName && !completed ? (
          <p className="hint">当前：{progress.currentName}</p>
        ) : null}
        {summary && summary.failed > 0 ? (
          <p className="hint">有 {summary.failed} 张头像识别失败，将在下次筛选时重试。</p>
        ) : null}
      </div>
    </Modal>
  )
}
