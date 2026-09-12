import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText, FileVideo } from 'lucide-react'
import type { PendingScanGroup, PendingScanResourceTarget } from '@shared/libraryTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api } from '../api'
import { ALL_CATALOG_SCOPE } from '../query/catalogScopes'
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
} from '../components/PendingDecisionParts'
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
  libraryName,
  onResolved
}: {
  group: PendingScanGroup
  libraryName?: string
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const [assignments, setAssignments] = useState<
    Record<number, PendingScanResourceTarget | undefined>
  >({})
  const [primaryByGroup, setPrimaryByGroup] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const existingQuery = useQuery({
    queryKey: ['pending-scan-existing-videos', group.libraryId, group.normalizedCode],
    queryFn: async () => {
      const result = await api.videos.list(ALL_CATALOG_SCOPE, {
        search: group.normalizedCode,
        limit: 200
      })
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
  }, [group.id, group.libraryId])

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
      await api.scan.resolvePending(group.libraryId, group.id, {
        expectedRevision: group.revision,
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
      eyebrow={`扫描资源 · ${libraryName ?? `媒体库 #${group.libraryId}`}`}
      title={`${group.normalizedCode} · 确认资源归属`}
      description={`同一番号下有 ${group.resources.length} 份资源需要确认，请选择各自所属的影片。`}
      status={complete ? '可确认' : '待确认'}
      statusTone={complete ? 'ok' : 'waiting'}
      confirm={
        <PendingConfirmBar
          summary={
            complete
              ? `${group.resources.length} 条资源将归入 ${summary.length} 部影片`
              : `还有 ${group.resources.length - assigned} 条资源未分配`
          }
          scope="将资源添加到所选影片，源文件保留在原位置"
        >
          <Button variant="primary" disabled={!complete || busy} onClick={() => void resolve()}>
            {busy ? '提交中…' : '确认全部分配'}
          </Button>
        </PendingConfirmBar>
      }
    >
      <PendingWorkspacePanel>
        <PendingStep step={1} title="为每条资源选择归属" hint="选择相同的新建影片，会将资源归入同一部影片">
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
                          新建影片 {key}
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
          title="确认后的影响"
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
