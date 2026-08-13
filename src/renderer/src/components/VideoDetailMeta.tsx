import { Fragment, useEffect, useRef, useState } from 'react'
import { Ellipsis, Link2, Play } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ScrapedStatus } from '@shared/commonTypes'
import type { OrganizationRole } from '@shared/classificationTypes'
import type {
  VideoDetail,
  VideoResourceDetail
} from '@shared/videoTypes'
import { VIDEO_BATCH_SCRAPE_STATUS_OPTIONS } from '@shared/videoScrapeTypes'
import MetaLink from './MetaLink'
import IconButton from './IconButton'
import EmptyState from './EmptyState'
import { UI_ICON } from './iconDefaults'
import {
  navigateToDirectorDetail,
  navigateToOrganizationDetail,
  navigateToSeriesDetail
} from '../listView/listNavigation'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import { VIDEO_RESOURCE_KIND_LABELS } from './videoResourcePresentation'

export type VideoPrimaryMetaItem =
  | { key: string; label: string; type: 'text'; value: string }
  | {
      key: string
      label: string
      type: 'organization'
      role: OrganizationRole
      organizationId: number
      value: string
    }
  | { key: string; label: string; type: 'director'; directorId: number; value: string }
  | { key: string; label: string; type: 'series'; seriesId: number; value: string }

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

export function buildVideoPrimaryMetaItems(video: VideoDetail): VideoPrimaryMetaItem[] {
  const items: VideoPrimaryMetaItem[] = []

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
  if (!isBlank(video.maker) && video.maker_organization_id != null) {
    items.push({
      key: 'maker',
      label: '制作商',
      type: 'organization',
      role: 'maker',
      organizationId: video.maker_organization_id,
      value: video.maker!.trim()
    })
  }
  if (!isBlank(video.publisher) && video.publisher_organization_id != null) {
    items.push({
      key: 'publisher',
      label: '发行商',
      type: 'organization',
      role: 'publisher',
      organizationId: video.publisher_organization_id,
      value: video.publisher!.trim()
    })
  }
  if (!isBlank(video.series) && video.series_id != null) {
    items.push({
      key: 'series',
      label: '系列',
      type: 'series',
      seriesId: video.series_id,
      value: video.series!.trim()
    })
  }
  if (!isBlank(video.director) && video.director_id != null) {
    items.push({
      key: 'director',
      label: '导演',
      type: 'director',
      directorId: video.director_id,
      value: video.director!.trim()
    })
  }

  return items
}

function fileBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || filePath
}

function localResourceDisplayName(resource: VideoResourceDetail, multi: boolean): string | null {
  const label = resource.display_name?.trim()
  if (label) return label
  if (!multi) return null
  return fileBaseName(resource.display_locator)
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

function ResourceReassignmentMenuItems({
  resource,
  onClose,
  onSetPrimaryResource,
  onSplitResource
}: {
  resource: VideoResourceDetail
  onClose: () => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="detail-menu-item"
        role="menuitem"
        onClick={() => {
          onClose()
          onSetPrimaryResource?.(resource.id)
        }}
      >
        设为主资源
      </button>
      <button
        type="button"
        className="detail-menu-item"
        role="menuitem"
        onClick={() => {
          onClose()
          onSplitResource?.(resource)
        }}
      >
        拆分为独立影片
      </button>
    </>
  )
}

function VideoLocalResourceRow({
  resource,
  multiResources,
  onOpenResource,
  onRevealResource,
  onSetPrimaryResource,
  onSplitResource,
  onEditResource,
  onRemoveResource
}: {
  resource: VideoResourceDetail
  multiResources: boolean
  onOpenResource?: (resourceId: number) => void
  onRevealResource?: (resourceId: number) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onEditResource?: (resource: VideoResourceDetail) => void
  onRemoveResource?: (resource: VideoResourceDetail) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const path = resource.display_locator.trim()
  const title = localResourceDisplayName(resource, multiResources) ?? fileBaseName(path)
  const isPrimary = Boolean(resource.is_primary)
  const facts = [
    resource.size_bytes != null && resource.size_bytes > 0
      ? { key: 'size', label: '大小', value: formatFileSize(resource.size_bytes) }
      : null,
    resource.duration_seconds != null && resource.duration_seconds > 0
      ? { key: 'duration', label: '时长', value: formatDuration(resource.duration_seconds) }
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
      className={`detail-meta-file${isPrimary && multiResources ? ' detail-meta-file--primary' : ''}`}
    >
      <div className="detail-meta-file-main">
        <div className="detail-meta-file-label-row">
          <span className="detail-meta-file-label">{title}</span>
          <span className="detail-meta-file-badge">{VIDEO_RESOURCE_KIND_LABELS.local}</span>
          {isPrimary ? (
            <span className="detail-meta-file-badge" title="顶部播放将使用此资源">
              主资源
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
          onClick={() => onOpenResource?.(resource.id)}
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
                  onEditResource?.(resource)
                }}
              >
                编辑标签
              </button>
              <button
                type="button"
                className="detail-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRevealResource?.(resource.id)
                }}
              >
                在文件夹中显示
              </button>
              {!isPrimary ? (
                <ResourceReassignmentMenuItems
                  resource={resource}
                  onClose={() => setMenuOpen(false)}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                />
              ) : null}
              <div className="detail-menu-separator" />
              <button
                type="button"
                className="detail-menu-item detail-menu-item--danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRemoveResource?.(resource)
                }}
              >
                删除本地文件
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function VideoLinkResourceRow({
  resource,
  multiResources,
  onOpenResource,
  onReadResourceLocator,
  onEditResource,
  onSetPrimaryResource,
  onSplitResource,
  onRemoveResource
}: {
  resource: VideoResourceDetail
  multiResources: boolean
  onOpenResource?: (resourceId: number) => void
  onReadResourceLocator?: (resourceId: number) => Promise<string | null>
  onEditResource?: (resource: VideoResourceDetail) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onRemoveResource?: (resource: VideoResourceDetail) => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const [fullLink, setFullLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const kind = VIDEO_RESOURCE_KIND_LABELS[resource.kind]
  const masked = resource.display_locator
  const title = resource.display_name?.trim() || masked
  const isPrimary = Boolean(resource.is_primary)

  const copyFullLink = async (): Promise<void> => {
    const locator = fullLink ?? (await onReadResourceLocator?.(resource.id))
    if (!locator) return
    await navigator.clipboard.writeText(locator)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const toggleFullLink = async (): Promise<void> => {
    if (fullLink !== null) {
      setFullLink(null)
      return
    }
    const locator = await onReadResourceLocator?.(resource.id)
    if (locator) setFullLink(locator)
  }

  useEscapeKey(() => setMenuOpen(false), menuOpen)

  useEffect(() => {
    if (!menuOpen) return
    const onDocClick = (event: MouseEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  return (
    <div
      className={`detail-meta-file${isPrimary && multiResources ? ' detail-meta-file--primary' : ''}`}
    >
      <div className="detail-meta-file-main">
        <div className="detail-meta-file-label-row">
          <span className="detail-meta-file-label">{title}</span>
          <span className="detail-meta-file-badge">{kind}</span>
          {isPrimary ? (
            <span className="detail-meta-file-badge" title="顶部播放将打开此资源">
              主资源
            </span>
          ) : null}
        </div>
        {resource.display_name?.trim() ? <div className="detail-meta-path">{masked}</div> : null}
        {resource.size_bytes != null && resource.size_bytes > 0 ? (
          <div className="detail-meta-file-facts">
            <span className="detail-meta-file-fact">
              <span>大小</span>
              <strong>{formatFileSize(resource.size_bytes)}</strong>
            </span>
          </div>
        ) : null}
        {fullLink ? <div className="detail-meta-path detail-meta-path--full">{fullLink}</div> : null}
      </div>
      <div className="detail-meta-file-actions">
        <IconButton
          className="detail-icon-action"
          icon={<Play {...UI_ICON} />}
          label={`打开${kind}`}
          onClick={() => onOpenResource?.(resource.id)}
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
                  setFullLink(null)
                  onEditResource?.(resource)
                }}
              >
                编辑资源
              </button>
              {!isPrimary ? (
                <ResourceReassignmentMenuItems
                  resource={resource}
                  onClose={() => setMenuOpen(false)}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                />
              ) : null}
              <button
                type="button"
                className="detail-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void toggleFullLink()
                }}
              >
                {fullLink ? '隐藏完整链接' : '查看完整链接'}
              </button>
              <button
                type="button"
                className="detail-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void copyFullLink()
                }}
              >
                {copied ? '已复制完整链接' : '复制完整链接'}
              </button>
              <div className="detail-menu-separator" />
              <button
                type="button"
                className="detail-menu-item detail-menu-item--danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRemoveResource?.(resource)
                }}
              >
                移除链接资源
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function VideoDetailPrimaryMeta({ video }: { video: VideoDetail }): JSX.Element | null {
  const navigate = useNavigate()
  const location = useLocation()
  const items = buildVideoPrimaryMetaItems(video)
  if (items.length === 0) return null

  return (
    <div className="meta-grid detail-meta-grid">
      {items.map((item) => (
        <Fragment key={item.key}>
          <span className="meta-key">{item.label}</span>
          <span className="meta-val">
            {item.type === 'organization' ? (
              <MetaLink
                onClick={() =>
                  navigateToOrganizationDetail(
                    navigate,
                    location,
                    item.role,
                    item.organizationId
                  )
                }
              >
                {item.value}
              </MetaLink>
            ) : item.type === 'director' ? (
              <MetaLink
                onClick={() => navigateToDirectorDetail(navigate, location, item.directorId)}
              >
                {item.value}
              </MetaLink>
            ) : item.type === 'series' ? (
              <MetaLink onClick={() => navigateToSeriesDetail(navigate, location, item.seriesId)}>
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
  onOpenResource,
  onRevealResource,
  onReadResourceLocator,
  onEditResource,
  onSetPrimaryResource,
  onSplitResource,
  onRemoveResource,
  onAddResource
}: {
  video: VideoDetail
  onOpenResource?: (resourceId: number) => void
  onRevealResource?: (resourceId: number) => void
  onReadResourceLocator?: (resourceId: number) => Promise<string | null>
  onEditResource?: (resource: VideoResourceDetail) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onRemoveResource?: (resource: VideoResourceDetail) => void
  onAddResource: () => void
}): JSX.Element {
  const multiResources = video.resources.length > 1

  return (
    <div className="detail-meta-sections">
      <section className="detail-section detail-meta-section">
        <div className="detail-section-head detail-section-head--with-actions">
          <h2 className="section-title">影片资源</h2>
          <div className="detail-section-actions">
            <span className="detail-section-count">{video.resources.length} 个</span>
            <IconButton
              className="detail-icon-action"
              icon={<Link2 {...UI_ICON} />}
              label="添加资源"
              onClick={onAddResource}
            />
          </div>
        </div>
        {video.resources.length > 0 ? (
          <div className="detail-meta-files">
            {video.resources.map((resource) =>
              resource.kind === 'local' ? (
                <VideoLocalResourceRow
                  key={resource.id}
                  resource={resource}
                  multiResources={multiResources}
                  onOpenResource={onOpenResource}
                  onRevealResource={onRevealResource}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                  onEditResource={onEditResource}
                  onRemoveResource={onRemoveResource}
                />
              ) : (
                <VideoLinkResourceRow
                  key={resource.id}
                  resource={resource}
                  multiResources={multiResources}
                  onOpenResource={onOpenResource}
                  onReadResourceLocator={onReadResourceLocator}
                  onEditResource={onEditResource}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                  onRemoveResource={onRemoveResource}
                />
              )
            )}
          </div>
        ) : (
          <EmptyState
            variant="compact"
            icon={<Link2 {...UI_ICON} aria-hidden />}
            title="暂无影片资源"
            description="添加资源后会在这里展示。"
          />
        )}
      </section>
    </div>
  )
}
