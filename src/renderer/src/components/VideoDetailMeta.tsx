import { Fragment, useEffect, useRef, useState } from 'react'
import { Ellipsis, Play } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { FacetType, ScrapedStatus, VideoDetail, VideoFile } from '@shared/types'
import { VIDEO_BATCH_SCRAPE_STATUS_OPTIONS } from '@shared/types'
import MetaLink from './MetaLink'
import IconButton from './IconButton'
import { UI_ICON } from './iconDefaults'
import { navigateToFacetDetail } from '../listView/listNavigation'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'

type PrimaryItem =
  | { key: string; label: string; type: 'text'; value: string }
  | { key: string; label: string; type: 'facet'; facet: FacetType; value: string }

type SecondaryItem =
  | { key: string; label: string; type: 'text'; value: string }
  | { key: string; label: string; type: 'path'; value: string }
  | { key: string; label: string; type: 'status'; status: ScrapedStatus }

function isBlank(value: string | null | undefined): boolean {
  return !value?.trim()
}

function formatTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return trimmed
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let size = bytes
  let unitIndex = -1
  do {
    size /= 1024
    unitIndex += 1
  } while (size >= 1024 && unitIndex < units.length - 1)
  const rounded = size >= 100 ? size.toFixed(0) : size.toFixed(1)
  return `${rounded} ${units[unitIndex]}`
}

export function getVideoScrapeStatusLabel(status: ScrapedStatus): string {
  return VIDEO_BATCH_SCRAPE_STATUS_OPTIONS.find((option) => option.id === status)?.label ?? '未知'
}

function buildPrimaryItems(video: VideoDetail): PrimaryItem[] {
  const items: PrimaryItem[] = []

  if (!isBlank(video.release_date)) {
    items.push({ key: 'release_date', label: '发行日期', type: 'text', value: video.release_date!.trim() })
  }
  const durationSeconds = video.resolved_duration_seconds
  if (durationSeconds != null && durationSeconds > 0) {
    items.push({
      key: 'duration_seconds',
      label: '时长',
      type: 'text',
      value: formatDuration(durationSeconds)
    })
  }
  if (!isBlank(video.maker)) {
    items.push({ key: 'maker', label: '制作商', type: 'facet', facet: 'maker', value: video.maker!.trim() })
  }
  if (!isBlank(video.publisher)) {
    items.push({
      key: 'publisher',
      label: '发行商',
      type: 'facet',
      facet: 'publisher',
      value: video.publisher!.trim()
    })
  }
  if (!isBlank(video.series)) {
    items.push({ key: 'series', label: '系列', type: 'facet', facet: 'series', value: video.series!.trim() })
  }
  if (!isBlank(video.director)) {
    items.push({
      key: 'director',
      label: '导演',
      type: 'facet',
      facet: 'director',
      value: video.director!.trim()
    })
  }

  return items
}

function fileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || filePath
}

function fileDisplayName(file: VideoFile, multi: boolean): string | null {
  if (!multi) return null
  const label = file.label?.trim()
  if (label) return label
  return fileBaseName(file.file_path)
}

function buildRecordItems(video: VideoDetail): SecondaryItem[] {
  const recordItems: SecondaryItem[] = [
    {
      key: 'scraped_status',
      label: '刮削状态',
      type: 'status',
      status: video.scraped_status
    }
  ]
  const scrapedAt = formatTimestamp(video.last_scraped_at)
  if (scrapedAt) {
    recordItems.push({ key: 'last_scraped_at', label: '最近刮削', type: 'text', value: scrapedAt })
  }
  const updatedAt = formatTimestamp(video.updated_at)
  if (updatedAt) {
    recordItems.push({ key: 'updated_at', label: '最近更新', type: 'text', value: updatedAt })
  }
  const addedAt = formatTimestamp(video.add_time)
  if (addedAt) {
    recordItems.push({ key: 'add_time', label: '添加时间', type: 'text', value: addedAt })
  }

  return recordItems
}

function VideoFileRow({
  file,
  multiFiles,
  onPlayFile,
  onRevealFile,
  onSetPrimaryFile,
  onDeleteFile
}: {
  file: VideoFile
  multiFiles: boolean
  onPlayFile?: (fileId: number) => void
  onRevealFile?: (fileId: number) => void
  onSetPrimaryFile?: (fileId: number) => void
  onDeleteFile?: (file: VideoFile) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const path = file.file_path.trim()
  const title = fileDisplayName(file, multiFiles) ?? fileBaseName(path)
  const isPrimary = Boolean(file.is_primary)
  const facts = [
    file.file_size != null && file.file_size > 0
      ? { key: 'size', label: '大小', value: formatFileSize(file.file_size) }
      : null,
    file.file_duration_seconds != null && file.file_duration_seconds > 0
      ? { key: 'duration', label: '时长', value: formatDuration(file.file_duration_seconds) }
      : null
  ].filter(Boolean) as Array<{ key: string; label: string; value: string }>

  useEscapeKey(() => setMenuOpen(false), menuOpen)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      if (isDismissExemptPortaledTarget(target)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  return (
    <div
      className={`detail-meta-file${isPrimary && multiFiles ? ' detail-meta-file--primary' : ''}`}
    >
      <div className="detail-meta-file-main">
        <div className="detail-meta-file-label-row">
          <span className="detail-meta-file-label">{title}</span>
          {isPrimary ? (
            <span className="detail-meta-file-badge" title="顶部播放将使用此文件">
              主文件
            </span>
          ) : null}
        </div>
        {facts.length > 0 ? (
          <div className="detail-meta-file-facts">
            {facts.map((fact) => (
              <span key={fact.key} className="detail-meta-file-fact">
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
        {!isBlank(path) ? <div className="detail-meta-path">{path}</div> : null}
      </div>
      <div className="detail-meta-file-actions">
        <IconButton
          className="detail-icon-action"
          icon={<Play {...UI_ICON} />}
          label="播放此文件"
          onClick={() => onPlayFile?.(file.id)}
        />
        <div className="detail-more-actions" ref={menuRef}>
          <IconButton
            className="detail-icon-action"
            icon={<Ellipsis {...UI_ICON} />}
            label="更多"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <div className="detail-more-menu" role="menu">
              <button
                type="button"
                className="detail-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRevealFile?.(file.id)
                }}
              >
                在文件夹中显示
              </button>
              {!isPrimary ? (
                <>
                  <button
                    type="button"
                    className="detail-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onSetPrimaryFile?.(file.id)
                    }}
                  >
                    设为主文件
                  </button>
                  <div className="detail-menu-separator" />
                  <button
                    type="button"
                    className="detail-menu-item detail-menu-item--danger"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false)
                      onDeleteFile?.(file)
                    }}
                  >
                    删除此文件
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function VideoDetailPrimaryMeta({ video }: { video: VideoDetail }): JSX.Element | null {
  const navigate = useNavigate()
  const items = buildPrimaryItems(video)
  if (items.length === 0) return null

  return (
    <div className="meta-grid detail-meta-grid">
      {items.map((item) => (
        <Fragment key={item.key}>
          <span className="meta-key">{item.label}</span>
          <span className="meta-val">
            {item.type === 'facet' ? (
              <MetaLink onClick={() => navigateToFacetDetail(navigate, item.facet, item.value)}>
                {item.value}
              </MetaLink>
            ) : (
              item.value
            )}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function maintenanceStatusClass(status: ScrapedStatus): string {
  if (status === 1) return 'detail-meta-status--success'
  return status === 2 ? 'detail-meta-status--failed' : 'detail-meta-status--unscraped'
}

export function VideoMaintenanceInfo({ video }: { video: VideoDetail }): JSX.Element {
  const recordItems = buildRecordItems(video)

  return (
    <dl className="detail-maintenance-grid">
      {recordItems.map((item) => (
        <div key={item.key} className="detail-maintenance-item">
          <dt>{item.label}</dt>
          <dd
            className={
              item.type === 'status'
                ? `detail-meta-status ${maintenanceStatusClass(item.status)}`
                : item.type === 'path'
                  ? 'detail-meta-path'
                  : undefined
            }
          >
            {item.type === 'status' ? getVideoScrapeStatusLabel(item.status) : item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function VideoDetailSecondaryMeta({
  video,
  onPlayFile,
  onRevealFile,
  onSetPrimaryFile,
  onDeleteFile
}: {
  video: VideoDetail
  onPlayFile?: (fileId: number) => void
  onRevealFile?: (fileId: number) => void
  onSetPrimaryFile?: (fileId: number) => void
  onDeleteFile?: (file: VideoFile) => void
}): JSX.Element | null {
  const multiFiles = video.files.length > 1
  const hasFiles = video.files.length > 0
  if (!hasFiles) return null

  return (
    <div className="detail-meta-sections">
      <section className="detail-section detail-meta-section">
        <div className="detail-section-head">
          <h2 className="section-title">文件</h2>
          <span className="detail-section-count">{video.files.length} 个</span>
        </div>
        <div className="detail-meta-files">
          {video.files.map((file) => (
            <VideoFileRow
              key={file.id}
              file={file}
              multiFiles={multiFiles}
              onPlayFile={onPlayFile}
              onRevealFile={onRevealFile}
              onSetPrimaryFile={onSetPrimaryFile}
              onDeleteFile={onDeleteFile}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
