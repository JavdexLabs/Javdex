import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CircleAlert, Trash2 } from 'lucide-react'
import type {
  PendingVideoScrape,
  PendingVideoScrapeConfirmInput,
  PendingVideoScrapeSource,
  ScrapeResult,
  VideoScrapeField
} from '@shared/videoScrapeTypes'
import {
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS
} from '@shared/videoScrapeTypes'
import { api, resolveMediaSrc } from '../api'
import Button from '../components/Button'
import Modal from '../components/Modal'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { navigateToVideoDetail } from '../listView/listNavigation'
import {
  PendingAlert,
  PendingConfirmBar,
  PendingImpactCard,
  PendingImpactCards,
  PendingImpactList,
  PendingImpactNote,
  PendingImpactPair,
  PendingMeta,
  PendingSecondaryActions,
  PendingStep,
  PendingWorkspace,
  PendingWorkspacePanel
} from './PendingDecisionParts'
import { arePendingScrapeSelectionsComplete } from './pendingCenterState'
import { formatBytes } from './pendingFormat'
import styles from './PendingScrapePane.module.css'

const FIELD_LABEL = new Map(VIDEO_SCRAPE_FIELD_OPTIONS.map((option) => [option.id, option.label]))
const UPDATE_MODE = new Map(
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS.map((option) => [option.id, option])
)

function fieldSummary(fields: VideoScrapeField[]): string {
  return fields.map((field) => FIELD_LABEL.get(field) ?? field).join('、')
}

/** Human-readable preview of what a candidate contributes for one field. */
function scrapeFieldPreview(field: VideoScrapeField, result: ScrapeResult): string | null {
  switch (field) {
    case 'title':
      return result.title?.trim() || null
    case 'summary':
      return result.summary?.trim() || null
    case 'cover':
      return result.coverUrl ? '1 张封面' : null
    case 'releaseDate':
      return result.releaseDate?.trim() || null
    case 'maker':
      return result.maker?.trim() || null
    case 'publisher':
      return result.publisher?.trim() || null
    case 'series':
      return result.series?.trim() || null
    case 'director':
      return result.director?.trim() || null
    case 'duration':
      return result.durationSeconds == null ? null : `${Math.round(result.durationSeconds / 60)} 分钟`
    case 'actressesFemale':
    case 'actressesMale': {
      const wanted = field === 'actressesMale' ? 'male' : 'female'
      const names = (result.actresses ?? [])
        .filter((actress) => (actress.gender ?? 'female') === wanted)
        .map((actress) => actress.name)
      return names.length > 0 ? names.join('、') : null
    }
    case 'tags':
      return result.tags?.length ? result.tags.join('、') : null
    case 'source':
      return result.sourceUrl?.trim() || null
    case 'rating':
      return result.ratingAverage == null ? null : `${result.ratingAverage.toFixed(1)} / 5`
    case 'samples':
      return result.sampleImageUrls?.length ? `${result.sampleImageUrls.length} 张样张` : null
    default:
      return null
  }
}

function candidateDetailRows(
  result: PendingVideoScrapeSource['candidates'][number]['result']
): Array<[string, string]> {
  const values: Array<[string, unknown]> = [
    ['标题', result.title],
    ['简介', result.summary],
    ['发行日期', result.releaseDate],
    ['发行商', result.publisher],
    ['制作商', result.maker],
    ['系列', result.series],
    ['导演', result.director],
    ['时长', result.durationSeconds == null ? null : `${Math.round(result.durationSeconds / 60)} 分钟`],
    ['演员', result.actresses?.map((actress) => actress.name).join('、')],
    ['标签', result.tags?.join('、')],
    [
      '评分',
      result.ratingAverage == null
        ? null
        : `${result.ratingAverage.toFixed(1)} / 5${result.ratingCount == null ? '' : ` · ${result.ratingCount} 人`}`
    ],
    ['来源', result.sourceUrl]
  ]
  return values.flatMap(([label, value]) =>
    typeof value === 'string' && value.trim() ? [[label, value] as [string, string]] : []
  )
}

export default function PendingScrapePane({
  pending,
  onResolved
}: {
  pending: PendingVideoScrape
  onResolved: () => void
}): JSX.Element {
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [selections, setSelections] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [mergeConflictId, setMergeConflictId] = useState<number | null>(null)
  const [directorChoice, setDirectorChoice] = useState<{
    candidates: Array<{ id: number; mainName: string; description: string | null }>
  } | null>(null)
  const [directorId, setDirectorId] = useState<number | null>(null)

  useEffect(() => {
    setSelections({})
    setMergeConflictId(null)
    setDirectorChoice(null)
    setDirectorId(null)
  }, [pending.id, pending.revision])

  const confirmInput = (): PendingVideoScrapeConfirmInput => ({
    pendingScrapeId: pending.id,
    selections: pending.sources.map((source) => ({
      sourceId: source.id,
      candidateId: selections[source.id]
    }))
  })
  const complete = arePendingScrapeSelectionsComplete(pending.sources, selections)
  const candidateCount = pending.sources.reduce((sum, source) => sum + source.candidates.length, 0)
  const chosenCount = pending.sources.filter((source) => selections[source.id] != null).length
  const mode = UPDATE_MODE.get(pending.updateMode)

  const impactBySource = pending.sources.map((source) => {
    const candidate = source.candidates.find((item) => item.id === selections[source.id])
    return {
      source,
      candidate,
      rows: candidate
        ? source.selectedFields.flatMap((field) => {
            const value = scrapeFieldPreview(field, candidate.result)
            return value ? [{ field, label: FIELD_LABEL.get(field) ?? field, value }] : []
          })
        : []
    }
  })
  const impactRowCount = impactBySource.reduce((sum, entry) => sum + entry.rows.length, 0)

  const confirm = async (extra: Partial<PendingVideoScrapeConfirmInput> = {}): Promise<void> => {
    if (!complete || busy) return
    setBusy(true)
    try {
      const result = await api.scrape.confirmPending({
        ...confirmInput(),
        ...(directorId == null ? {} : { directorSelectionId: directorId }),
        ...extra
      })
      if (result.status === 'merge-required' && result.conflictVideoId) {
        setDirectorChoice(null)
        setMergeConflictId(result.conflictVideoId)
        return
      }
      if (result.directorChoice) {
        setMergeConflictId(null)
        setDirectorChoice(result.directorChoice)
        setDirectorId(null)
        return
      }
      toast.show(
        result.applied ? '候选已应用' : '没有可写入字段，已跳过',
        result.applied ? 'success' : 'info'
      )
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const discard = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.scrape.discardPending(pending.id)
      toast.show('候选已丢弃并清理暂存资源', 'success')
      setDiscardOpen(false)
      onResolved()
    } catch (error) {
      toast.show((error as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const overlays = (
    <>
      {discardOpen ? (
        <Modal
          title="丢弃影片刮削候选？"
          hint={`将删除 ${candidateCount} 个候选及 ${formatBytes(pending.stagedBytes)} 暂存资源。关闭窗口本身不会执行此操作。`}
          danger
          busy={busy}
          confirmText="确认丢弃"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={() => void discard()}
        >
          <p className="copyable-text">
            影片 #{pending.videoId} 的本次刮削会记为失败；已有累计成功状态不会降级。
          </p>
        </Modal>
      ) : null}

      {mergeConflictId != null ? (
        <Modal
          title="合并并应用候选"
          hint={`所选候选与影片 #${mergeConflictId} 的业务身份相同。请选择要保留的永久内部 ID。`}
          size="sm"
          hideCancel
          onCancel={() => setMergeConflictId(null)}
          actions={
            <>
              <Button onClick={() => setMergeConflictId(null)}>取消</Button>
              <Button
                variant="danger"
                onClick={() => void confirm({ mergeRetainedVideoId: mergeConflictId })}
              >
                保留 #{mergeConflictId}
              </Button>
              <Button
                variant="danger"
                onClick={() => void confirm({ mergeRetainedVideoId: pending.videoId })}
              >
                保留 #{pending.videoId}
              </Button>
            </>
          }
        >
          <p>两部影片的资源和关系将原子收敛，随后应用当前候选；任一步失败都不会部分提交。</p>
        </Modal>
      ) : null}

      {directorChoice ? (
        <Modal
          title="选择导演"
          hint="导演名称匹配到多个分类实体；完成选择前不会写入其他候选字段。"
          confirmDisabled={directorId == null}
          confirmText="选择并应用"
          onCancel={() => {
            setDirectorChoice(null)
            setDirectorId(null)
          }}
          onConfirm={() => directorId != null && void confirm({ directorSelectionId: directorId })}
        >
          <div className={styles.directorOptions}>
            {directorChoice.candidates.map((candidate) => (
              <label className={styles.directorOption} key={candidate.id}>
                <input
                  type="radio"
                  name="pending-director"
                  checked={directorId === candidate.id}
                  onChange={() => setDirectorId(candidate.id)}
                />
                <span>
                  <strong>{candidate.mainName}</strong>
                  {candidate.description ? <small>{candidate.description}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </Modal>
      ) : null}
    </>
  )

  return (
    <PendingWorkspace
      eyebrow="影片刮削"
      title={
        pending.sources.length > 1
          ? `影片 #${pending.videoId} 的 ${pending.sources.length} 个来源各应采用哪个候选？`
          : `影片 #${pending.videoId} 应采用哪个候选？`
      }
      description="插件返回了多个精确匹配，或候选与其他影片的业务身份重合。关闭页面不会丢弃候选。"
      status={complete ? '可应用' : '待确认'}
      statusTone={complete ? 'ok' : 'waiting'}
      alert={
        pending.warnings.length > 0 ? (
          <PendingAlert>
            {pending.warnings.map((warning, index) => (
              <span key={`${warning}-${index}`}>{warning}</span>
            ))}
          </PendingAlert>
        ) : null
      }
      confirm={
        <PendingConfirmBar
          summary={
            complete
              ? `将向影片 #${pending.videoId} 写入 ${impactRowCount} 个字段`
              : `还有 ${pending.sources.length - chosenCount} 个来源未选择候选`
          }
          scope={`按原选字段与「${mode?.label ?? pending.updateMode}」写入本影片`}
        >
          <Button variant="primary" size="sm" disabled={!complete || busy} onClick={() => void confirm()}>
            {busy ? '处理中…' : '应用所选候选'}
          </Button>
        </PendingConfirmBar>
      }
      secondary={
        <PendingSecondaryActions>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigateToVideoDetail(navigate, location, pending.videoId)}
          >
            查看影片
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDiscardOpen(true)}>
            <Trash2 {...UI_ICON_SM} aria-hidden />
            丢弃全部候选
          </Button>
        </PendingSecondaryActions>
      }
      overlays={overlays}
    >
      <PendingWorkspacePanel>
        <PendingStep
          step={1}
          title="为每个来源选择候选"
          hint={`共 ${candidateCount} 个候选 · 暂存 ${formatBytes(pending.stagedBytes)}`}
        >
          <div className={styles.sourceList}>
            {pending.sources.map((source) => (
              <section className={styles.source} key={source.id}>
                <header className={styles.sourceHeader}>
                  <div className={styles.sourceIdentity}>
                    <strong>{source.pluginName}</strong>
                    <span>
                      {source.pluginVersion || '版本未知'} · {source.sourceName}
                    </span>
                  </div>
                  <small>{fieldSummary(source.selectedFields)}</small>
                </header>
                <div className={styles.candidateGrid}>
                  {source.candidates.map((candidate) => {
                    const cover = resolveMediaSrc(candidate.stagedCoverPath)
                    const samples = candidate.stagedSamplePaths
                      .map(resolveMediaSrc)
                      .filter((value): value is string => Boolean(value))
                    const avatars = candidate.stagedActressAvatarPaths
                      .map(resolveMediaSrc)
                      .filter((value): value is string => Boolean(value))
                    const selected = selections[source.id] === candidate.id
                    return (
                      <label className={styles.candidate} key={candidate.id}>
                        <input
                          type="radio"
                          name={`source-${source.id}`}
                          checked={selected}
                          onChange={() => {
                            setSelections((current) => ({ ...current, [source.id]: candidate.id }))
                            setMergeConflictId(null)
                            setDirectorChoice(null)
                            setDirectorId(null)
                          }}
                        />
                        <div className={styles.candidateCover}>
                          {cover ? (
                            <img src={cover} alt="" draggable={false} />
                          ) : (
                            <CircleAlert aria-hidden />
                          )}
                        </div>
                        <div className={styles.candidateCopy}>
                          <strong>{candidate.result.title || candidate.result.code}</strong>
                          {candidateDetailRows(candidate.result).map(([label, value]) => (
                            <div className={styles.candidateRow} key={label}>
                              <span>{label}</span>
                              <b className="copyable-text">{value}</b>
                            </div>
                          ))}
                        </div>
                        {samples.length > 0 || avatars.length > 0 ? (
                          <div className={styles.candidateMedia} aria-label="候选暂存图片">
                            {samples.map((sample, index) => (
                              <img
                                src={sample}
                                alt={`候选样张 ${index + 1}`}
                                draggable={false}
                                key={`sample-${index}`}
                              />
                            ))}
                            {avatars.map((avatar, index) => (
                              <img
                                data-avatar="true"
                                src={avatar}
                                alt={`候选演员头像 ${index + 1}`}
                                draggable={false}
                                key={`avatar-${index}`}
                              />
                            ))}
                          </div>
                        ) : null}
                      </label>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </PendingStep>

        <PendingStep
          step={2}
          title="查看确认后的影响"
          hint={`原选字段：${fieldSummary(pending.selectedFields) || '无'}`}
        >
          <PendingMeta>
            <span>更新方式：{mode?.label ?? pending.updateMode}</span>
            {mode ? <span>{mode.description}</span> : null}
          </PendingMeta>
          <PendingImpactCards>
            {impactBySource.map((entry) => (
              <PendingImpactCard
                key={entry.source.id}
                open={Boolean(entry.candidate)}
                title={`来自「${entry.source.pluginName}」的写入`}
                note={entry.candidate ? `${entry.rows.length} 个字段` : '未选择候选'}
              >
                {entry.rows.length === 0 ? (
                  <PendingImpactNote>
                    {entry.candidate
                      ? '所选候选在本来源的字段上没有返回值。'
                      : '选择候选后可预览将写入的字段。'}
                  </PendingImpactNote>
                ) : (
                  <PendingImpactList>
                    {entry.rows.map((row) => (
                      <PendingImpactPair key={row.field} label={row.label} value={row.value} />
                    ))}
                  </PendingImpactList>
                )}
              </PendingImpactCard>
            ))}
          </PendingImpactCards>
        </PendingStep>
      </PendingWorkspacePanel>
    </PendingWorkspace>
  )
}
