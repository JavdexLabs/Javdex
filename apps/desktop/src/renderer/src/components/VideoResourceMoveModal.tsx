import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import type { MediaLibrarySummary } from '@shared/mediaLibraryTypes'
import type { VideoLifecycleImpact, VideoLifecycleResult } from '@shared/videoLifecycleTypes'
import type { VideoResourceDetail } from '@shared/videoTypes'
import { api } from '../api'
import Button from './Button'
import { AppFormField } from './FormPrimitives'
import Modal from './Modal'
import SelectControl from './SelectControl'
import styles from './VideoResourceMoveModal.module.css'

interface VideoResourceMoveModalProps {
  sourceLibraryId: number
  resource: VideoResourceDetail
  onCancel: () => void
  onMoved: (result: VideoLifecycleResult) => void
}

function createOperationId(resourceId: number): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `move-resource-${resourceId}-${Date.now()}`
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error)
}

export default function VideoResourceMoveModal({
  sourceLibraryId,
  resource,
  onCancel,
  onMoved
}: VideoResourceMoveModalProps): JSX.Element {
  const [libraries, setLibraries] = useState<MediaLibrarySummary[]>([])
  const [targetLibraryId, setTargetLibraryId] = useState<number | null>(null)
  const [impact, setImpact] = useState<VideoLifecycleImpact | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [loadingLibraries, setLoadingLibraries] = useState(true)
  const [previewing, setPreviewing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadingLibraries(true)
    api.mediaLibraries
      .list()
      .then((items) => {
        if (cancelled) return
        const active = items.filter(
          (library) => library.id !== sourceLibraryId && library.status === 'active'
        )
        setLibraries(items)
        setTargetLibraryId(active[0]?.id ?? null)
      })
      .catch((loadError) => {
        if (!cancelled) setError(errorMessage(loadError))
      })
      .finally(() => {
        if (!cancelled) setLoadingLibraries(false)
      })
    return () => {
      cancelled = true
    }
  }, [sourceLibraryId])

  const targets = useMemo(
    () =>
      libraries.filter(
        (library) => library.id !== sourceLibraryId && library.status === 'active'
      ),
    [libraries, sourceLibraryId]
  )
  const source = libraries.find((library) => library.id === sourceLibraryId)
  const target = targets.find((library) => library.id === targetLibraryId)
  const targetAlreadyHasMembership = Boolean(
    impact?.libraries.some((library) => library.libraryId === targetLibraryId)
  )
  const busy = previewing || moving

  const readPreview = async (): Promise<void> => {
    if (targetLibraryId == null || busy) return
    setPreviewing(true)
    setError(null)
    try {
      const nextImpact = await api.videos.previewMoveResource(
        sourceLibraryId,
        targetLibraryId,
        resource.id
      )
      setImpact(nextImpact)
      setOperationId(createOperationId(resource.id))
    } catch (previewError) {
      setImpact(null)
      setOperationId(null)
      setError(errorMessage(previewError))
    } finally {
      setPreviewing(false)
    }
  }

  const moveResource = async (): Promise<void> => {
    if (!impact || !operationId || targetLibraryId == null || busy) return
    setMoving(true)
    setError(null)
    try {
      const result = await api.videos.moveResource({
        sourceLibraryId,
        targetLibraryId,
        resourceId: resource.id,
        operationId,
        expectedRevision: impact.revision
      })
      onMoved(result)
    } catch (moveError) {
      // Keep the same idempotency key and revision so an uncertain local IPC response can be
      // retried safely. The user can explicitly re-read the preview when the state is stale.
      setError(errorMessage(moveError))
    } finally {
      setMoving(false)
    }
  }

  return (
    <Modal
      title="移动资源到其它媒体库"
      size="md"
      confirmText={
        moving
          ? '移动中…'
          : previewing
            ? '读取影响…'
            : impact
              ? '确认移动'
              : '读取影响'
      }
      confirmDisabled={loadingLibraries || targetLibraryId == null}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => void (impact ? moveResource() : readPreview())}
    >
      <div className={styles.body}>
        <div className={styles.resourceCard}>
          <span className={styles.resourceKind}>外部链接资源</span>
          <strong className={styles.resourceName}>
            {resource.display_name?.trim() || resource.display_locator}
          </strong>
          {resource.display_name?.trim() ? (
            <span className={`${styles.resourceLocator} copyable-text`}>
              {resource.display_locator}
            </span>
          ) : null}
        </div>

        <AppFormField
          label="目标媒体库"
          hint="仅显示活动媒体库；本地文件和 STRM 资源必须在媒体库来源设置中迁移根目录。"
        >
          <SelectControl
            className={styles.targetSelect}
            value={targetLibraryId ?? ''}
            disabled={loadingLibraries || busy || targets.length === 0}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              setTargetLibraryId(Number(event.target.value))
              setImpact(null)
              setOperationId(null)
              setError(null)
            }}
          >
            {loadingLibraries ? (
              <option value="">正在读取媒体库…</option>
            ) : targets.length === 0 ? (
              <option value="">没有可用的目标媒体库</option>
            ) : (
              targets.map((library) => (
                <option key={library.id} value={library.id}>
                  {library.name}
                </option>
              ))
            )}
          </SelectControl>
        </AppFormField>

        {impact && target ? (
          <>
            <div className={styles.route} aria-label="资源归属变化">
              <span>{source?.name ?? `媒体库 #${sourceLibraryId}`}</span>
              <span aria-hidden>→</span>
              <strong>{target.name}</strong>
            </div>
            <dl className={styles.impactGrid}>
              <div className={styles.impactItem}>
                <dt>移动资源</dt>
                <dd>{impact.resourceIds.length}</dd>
              </div>
              <div className={styles.impactItem}>
                <dt>目标成员关系</dt>
                <dd>{targetAlreadyHasMembership ? '已存在' : '将创建'}</dd>
              </div>
              <div className={styles.impactItem}>
                <dt>全局影片资料</dt>
                <dd>保留</dd>
              </div>
            </dl>
            <p className={styles.note}>
              只改变这条外部链接的媒体库归属。源库成员关系会保留；若迁出的是主资源，源库会自动选择剩余资源补位；目标库已有主资源时，迁入链接会作为备用资源。
            </p>
          </>
        ) : (
          <p className={styles.note}>
            先读取影响，再使用预览返回的 revision 提交；预览后影片资源或任一相关媒体库发生变化时，提交会失败。
          </p>
        )}

        {error ? (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            {impact ? (
              <Button size="sm" disabled={busy} onClick={() => void readPreview()}>
                重新读取影响
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
