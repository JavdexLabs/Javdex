import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, FileVideo } from 'lucide-react'
import type { PendingScanGroup, PendingScanResourceTarget } from '@shared/libraryTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api } from '../api'
import Button from '../components/Button'
import SelectControl from '../components/SelectControl'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { VIDEO_RESOURCE_KIND_LABELS } from '../components/videoResourcePresentation'
import {
  PendingConfirmBar,
  PendingImpactList,
  PendingImpactNote,
  PendingImpactPair,
  PendingImpactPanel,
  PendingStep,
  PendingWorkspace,
  PendingWorkspacePanel
} from './PendingDecisionParts'
import {
  arePendingScanAssignmentsComplete,
  defaultPendingScanPrimaryResourceId,
  pendingResourceDisplayName,
  pendingScanTargetFromValue,
  pendingScanTargetValue,
  summarizePendingScanAssignments
} from './pendingCenterState'
import { formatBytes } from './pendingFormat'
import styles from './PendingScanPane.module.css'

function formatDuration(value: number | null): string {
  if (value == null) return '时长未知'
  const minutes = Math.floor(value / 60)
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

export default function PendingScanPane({
  group,
  onResolved
}: {
  group: PendingScanGroup
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const [assignments, setAssignments] = useState<
    Record<number, PendingScanResourceTarget | undefined>
  >({})
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const existingQuery = useQuery({
    queryKey: ['pending-scan-existing-videos', group.normalizedCode],
    queryFn: async () => {
      const result = await api.videos.list({ search: group.normalizedCode, limit: 200 })
      return result.items.filter((video) => {
        try {
          return normalizeVideoCode(video.code) === group.normalizedCode
        } catch {
          return false
        }
      })
    }
  })
  useEffect(() => {
    setAssignments({})
    setPrimaryByGroup({})
  }, [group.id])

  const complete = arePendingScanAssignmentsComplete(
    group.resources.map((resource) => resource.id),
    assignments
  )
  const newGroupKeys = Array.from({ length: group.resources.length }, (_, index) => String(index + 1))
  const assigned = group.resources.filter((resource) => assignments[resource.id]).length
  const summary = summarizePendingScanAssignments(group.resources, assignments, primaryByGroup)

  const resolve = async (): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    try {
      await api.scan.resolvePending(group.id, {
        assignments: group.resources.map((resource) => ({
          resourceId: resource.id,
          target: assignments[resource.id]!
        })),
        primaryResourceIds: primaryByGroup
      })
      toast.show('待确认扫描资源已完成分配', 'success')
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PendingWorkspace
      eyebrow="扫描资源"
      title={`「${group.normalizedCode}」的 ${group.resources.length} 条资源属于哪部影片？`}
      description="扫描到同一番号的多份文件，无法自动判断归属。每条资源必须恰好分配一次。"
      status={complete ? '可确认' : '待确认'}
      statusTone={complete ? 'ok' : 'waiting'}
      confirm={
        <PendingConfirmBar
          summary={
            complete
              ? `将建立 ${summary.length} 组归属`
              : `还有 ${group.resources.length - assigned} 条资源未分配`
          }
          scope="仅写入本组资源的归属，不合并任何现有影片"
        >
          <Button variant="primary" size="sm" disabled={!complete || busy} onClick={() => void resolve()}>
            {busy ? '提交中…' : '确认全部分配'}
          </Button>
        </PendingConfirmBar>
      }
    >
      <PendingWorkspacePanel>
        <PendingStep step={1} title="为每条资源选择归属" hint="选择只生成预览，不会立即写入">
          <div className={styles.resources}>
            {group.resources.map((resource) => {
              const isStrm = resource.sourceKind === 'strm'
              const targetKindLabel = resource.targetKind
                ? VIDEO_RESOURCE_KIND_LABELS[resource.targetKind]
                : null
              const target = assignments[resource.id]
              const newGroupKey = target?.kind === 'new' ? target.groupKey : null
              const defaultPrimaryId = newGroupKey
                ? defaultPendingScanPrimaryResourceId(
                    group.resources.filter((candidate) => {
                      const candidateTarget = assignments[candidate.id]
                      return (
                        candidateTarget?.kind === 'new' && candidateTarget.groupKey === newGroupKey
                      )
                    })
                  )
                : null
              const effectivePrimaryId = newGroupKey
                ? primaryByGroup[newGroupKey] ?? defaultPrimaryId
                : null
              return (
                <article className={styles.row} key={resource.id}>
                  {isStrm ? (
                    <FileText {...UI_ICON_SM} aria-hidden />
                  ) : (
                    <FileVideo {...UI_ICON_SM} aria-hidden />
                  )}
                  <div className={styles.copy}>
                    <div className={styles.titleRow}>
                      <strong className="copyable-text">{pendingResourceDisplayName(resource)}</strong>
                      {isStrm ? (
                        <span className={styles.kind}>
                          {targetKindLabel ? `STRM · ${targetKindLabel}` : 'STRM'}
                        </span>
                      ) : null}
                    </div>
                    <span className={`copyable-text ${styles.path}`}>{resource.filePath}</span>
                    {isStrm && resource.targetDisplay ? (
                      <span className={`copyable-text ${styles.targetDisplay}`}>
                        {resource.targetDisplay}
                      </span>
                    ) : null}
                    <small className={styles.facts}>
                      {isStrm ? '链接资源' : formatDuration(resource.durationSeconds)} ·{' '}
                      {resource.sizeBytes == null ? '大小未知' : formatBytes(resource.sizeBytes)}
                    </small>
                  </div>
                  <div className={styles.target}>
                    <SelectControl
                      aria-label={`分配 ${pendingResourceDisplayName(resource)}`}
                      value={pendingScanTargetValue(target)}
                      onChange={(event) => {
                        const nextTarget = pendingScanTargetFromValue(event.target.value)
                        if (
                          target?.kind === 'new' &&
                          primaryByGroup[target.groupKey] === resource.id
                        ) {
                          setPrimaryByGroup((current) => {
                            const next = { ...current }
                            delete next[target.groupKey]
                            return next
                          })
                        }
                        setAssignments((current) => ({ ...current, [resource.id]: nextTarget }))
                      }}
                    >
                      <option value="">选择归属…</option>
                      {(existingQuery.data ?? []).map((video) => (
                        <option key={video.id} value={`existing:${video.id}`}>
                          现有影片 #{video.id}
                          {video.title ? ` · ${video.title}` : ''}
                        </option>
                      ))}
                      {newGroupKeys.map((key) => (
                        <option key={key} value={`new:${key}`}>
                          新影片分组 {key}
                        </option>
                      ))}
                    </SelectControl>
                    {newGroupKey ? (
                      <label className={styles.primaryChoice}>
                        <input
                          type="radio"
                          name={`primary-${newGroupKey}`}
                          checked={effectivePrimaryId === resource.id}
                          onChange={() =>
                            setPrimaryByGroup((current) => ({
                              ...current,
                              [newGroupKey]: resource.id
                            }))
                          }
                        />
                        设为该新影片的主资源
                      </label>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        </PendingStep>

        <PendingStep
          step={2}
          title="查看确认后的影响"
          hint={`${assigned} / ${group.resources.length} 条资源已分配`}
        >
          <PendingImpactPanel>
            {summary.length === 0 ? (
              <PendingImpactNote>先为资源选择归属，才能预览分配结果。</PendingImpactNote>
            ) : (
              <PendingImpactList>
                {summary.map((entry) => (
                  <PendingImpactPair key={entry.key} label={entry.label} value={entry.detail} />
                ))}
              </PendingImpactList>
            )}
          </PendingImpactPanel>
        </PendingStep>
      </PendingWorkspacePanel>
    </PendingWorkspace>
  )
}
