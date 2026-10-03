import { Fragment, useEffect, useRef, useState } from 'react'
import { Check, Copy, Ellipsis, ExternalLink, Link2, Play } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ScrapedStatus } from '@shared/commonTypes'
import type { OrganizationRole } from '@shared/classificationTypes'
import type {
  VideoDetail,
  VideoResourceDetail
} from '@shared/videoTypes'
import { VIDEO_BATCH_SCRAPE_STATUS_OPTIONS } from '@shared/videoScrapeTypes'
import MetaLink from './MetaLink'
import DetailIconButton from './DetailIconButton'
import { DetailMenuAnchor, DetailMenuItem, DetailMenuPanel, DetailMenuSeparator } from './DetailMenu'
import EmptyState from './EmptyState'
import DetailSectionTitle from './DetailSectionTitle'
import { DetailSection, DetailSectionActions, DetailSectionCount, DetailSectionHead } from './DetailSection'
import { UI_ICON } from './iconDefaults'
import {
  navigateToDirectorDetail,
  navigateToOrganizationDetail,
  navigateToSeriesDetail
} from '../listView/listNavigation'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import { VIDEO_RESOURCE_KIND_LABELS } from './videoResourcePresentation'
import ScrapeStatusBadge from './ScrapeStatusBadge'
import styles from './VideoDetailMeta.module.css'

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
      <DetailMenuItem
        onClick={() => {
          onClose()
          onSetPrimaryResource?.(resource.id)
        }}
      >
        设为主资源
      </DetailMenuItem>
      <DetailMenuItem
        onClick={() => {
          onClose()
          onSplitResource?.(resource)
        }}
      >
        拆分为独立影片
      </DetailMenuItem>
    </>
  )
}

function VideoLocalResourceRow({
  resource,
  multiResources,
  onOpenResource,
  onBuiltinResource,
  onRevealResource,
  onSetPrimaryResource,
  onSplitResource,
  onMoveResource,
  onEditResource,
  onRemoveResource
}: {
  resource: VideoResourceDetail
  multiResources: boolean
  onOpenResource?: (resourceId: number, player?: 'external') => void
  onBuiltinResource?: (resourceId: number, privateSession?: boolean) => void
  onRevealResource?: (resourceId: number) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onMoveResource?: (resource: VideoResourceDetail) => void
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
    <div data-resource-row className={styles.file}>
      <div className={styles.fileMain}>
        <div className={styles.labelRow}>
          <span className={styles.fileLabel}>{title}</span>
          <span className={styles.badge}>{VIDEO_RESOURCE_KIND_LABELS.local}</span>
          {isPrimary ? (
            <span className={styles.badge} title="顶部播放将使用此资源">
              主资源
            </span>
          ) : null}
        </div>
        {facts.length > 0 ? (
          <div className={styles.facts}>
            {facts.map((fact) => (
              <span key={fact.key} className={styles.fact}>
                <span>{fact.label}</span>
                <strong>{fact.value}</strong>
              </span>
            ))}
          </div>
        ) : null}
        {!isBlank(path) ? <div className={styles.path}>{path}</div> : null}
      </div>
      <div className={styles.actions}>
        <DetailIconButton
          className={styles.resourceAction}
          icon={<Play {...UI_ICON} />}
          label="播放此文件"
          onClick={() => onOpenResource?.(resource.id)}
        />
        <DetailMenuAnchor ref={menuRef}>
          <DetailIconButton
            className={styles.resourceAction}
            icon={<Ellipsis {...UI_ICON} />}
            label="更多"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <DetailMenuPanel>
              {onBuiltinResource && <DetailMenuItem onClick={() => { setMenuOpen(false); onBuiltinResource(resource.id) }}>
                内置播放
              </DetailMenuItem>}
              {onBuiltinResource && <DetailMenuItem onClick={() => { setMenuOpen(false); onBuiltinResource(resource.id, true) }}>
                内置播放（本次不保存进度）
              </DetailMenuItem>}
              {onOpenResource && <DetailMenuItem onClick={() => { setMenuOpen(false); onOpenResource(resource.id, 'external') }}>
                外部播放
              </DetailMenuItem>}
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onEditResource?.(resource)
                }}
              >
                编辑标签
              </DetailMenuItem>
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onRevealResource?.(resource.id)
                }}
              >
                在文件夹中显示
              </DetailMenuItem>
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onMoveResource?.(resource)
                }}
              >
                移动到其它媒体库
              </DetailMenuItem>
              {!isPrimary ? (
                <ResourceReassignmentMenuItems
                  resource={resource}
                  onClose={() => setMenuOpen(false)}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                />
              ) : null}
              <DetailMenuSeparator />
              <DetailMenuItem
                danger
                onClick={() => {
                  setMenuOpen(false)
                  onRemoveResource?.(resource)
                }}
              >
                删除本地文件
              </DetailMenuItem>
            </DetailMenuPanel>
          ) : null}
        </DetailMenuAnchor>
      </div>
    </div>
  )
}

function VideoLinkResourceRow({
  resource,
  onOpenResource,
  onRevealResource,
  onReadResourceLocator,
  onEditResource,
  onSetPrimaryResource,
  onSplitResource,
  onMoveResource,
  onRemoveResource
}: {
  resource: VideoResourceDetail
  onOpenResource?: (resourceId: number) => void
  onRevealResource?: (resourceId: number) => void
  onReadResourceLocator?: (resourceId: number) => Promise<string | null>
  onEditResource?: (resource: VideoResourceDetail) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onMoveResource?: (resource: VideoResourceDetail) => void
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
  const isStrm = Boolean(resource.strm_source_path)

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
    <div data-resource-row className={styles.file}>
      <div className={styles.fileMain}>
        <div className={styles.labelRow}>
          <span className={styles.fileLabel}>{title}</span>
          <span className={styles.badge}>{kind}</span>
          {isStrm ? <span className={styles.badge}>STRM 托管</span> : null}
          {isPrimary ? (
            <span className={styles.badge} title="顶部播放将打开此资源">
              主资源
            </span>
          ) : null}
        </div>
        {resource.display_name?.trim() ? <div className={styles.path}>{masked}</div> : null}
        {resource.strm_source_path ? (
          <div className={`${styles.path} copyable-text`}>源文件 · {resource.strm_source_path}</div>
        ) : null}
        {resource.size_bytes != null && resource.size_bytes > 0 ? (
          <div className={styles.facts}>
            <span className={styles.fact}>
              <span>大小</span>
              <strong>{formatFileSize(resource.size_bytes)}</strong>
            </span>
          </div>
        ) : null}
        {fullLink ? <div className={`${styles.path} ${styles.pathFull}`}>{fullLink}</div> : null}
      </div>
      <div className={styles.actions}>
        <DetailIconButton
          className={styles.resourceAction}
          icon={copied ? <Check {...UI_ICON} /> : <Copy {...UI_ICON} />}
          label={copied ? '已复制链接' : '复制链接'}
          onClick={() => void copyFullLink()}
        />
        <DetailIconButton
          className={styles.resourceAction}
          icon={<ExternalLink {...UI_ICON} />}
          label={`打开${kind}`}
          onClick={() => onOpenResource?.(resource.id)}
        />
        <DetailMenuAnchor ref={menuRef}>
          <DetailIconButton
            className={styles.resourceAction}
            icon={<Ellipsis {...UI_ICON} />}
            label="更多"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          />
          {menuOpen ? (
            <DetailMenuPanel>
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  setFullLink(null)
                  onEditResource?.(resource)
                }}
              >
                编辑资源信息
              </DetailMenuItem>
              {isStrm ? (
                <DetailMenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    onRevealResource?.(resource.id)
                  }}
                >
                  在文件夹中显示
                </DetailMenuItem>
              ) : null}
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  onMoveResource?.(resource)
                }}
              >
                移动到其它媒体库
              </DetailMenuItem>
              {!isPrimary ? (
                <ResourceReassignmentMenuItems
                  resource={resource}
                  onClose={() => setMenuOpen(false)}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                />
              ) : null}
              <DetailMenuItem
                onClick={() => {
                  setMenuOpen(false)
                  void toggleFullLink()
                }}
              >
                {fullLink ? '隐藏完整链接' : '查看完整链接'}
              </DetailMenuItem>
              <DetailMenuSeparator />
              <DetailMenuItem
                danger
                onClick={() => {
                  setMenuOpen(false)
                  onRemoveResource?.(resource)
                }}
              >
                {isStrm ? '删除 STRM 源文件' : '移除链接资源'}
              </DetailMenuItem>
            </DetailMenuPanel>
          ) : null}
        </DetailMenuAnchor>
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
    <div className={styles.primaryGrid} data-primary-meta>
      {items.map((item) => (
        <Fragment key={item.key}>
          <span className={styles.primaryKey}>{item.label}</span>
          <span className={styles.primaryValue}>
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

export function VideoMaintenanceInfo({ video }: { video: VideoDetail }): JSX.Element {
  const recordItems = buildRecordItems(video)

  return (
    <dl className={styles.maintenanceGrid} data-maintenance-meta>
      {recordItems.map((item) => (
        <div key={item.key} className={styles.maintenanceItem}>
          <dt>{item.label}</dt>
          {item.type === 'status' ? (
            <ScrapeStatusBadge as="dd" status={item.status}>
              {getVideoScrapeStatusLabel(item.status)}
            </ScrapeStatusBadge>
          ) : (
            <dd>{item.value}</dd>
          )}
        </div>
      ))}
    </dl>
  )
}

export function VideoDetailSecondaryMeta({
  video,
  onOpenResource,
  onBuiltinResource,
  onRevealResource,
  onReadResourceLocator,
  onEditResource,
  onSetPrimaryResource,
  onSplitResource,
  onMoveResource,
  onRemoveResource,
  onAddResource
}: {
  video: VideoDetail
  onOpenResource?: (resourceId: number, player?: 'external') => void
  onBuiltinResource?: (resourceId: number, privateSession?: boolean) => void
  onRevealResource?: (resourceId: number) => void
  onReadResourceLocator?: (resourceId: number) => Promise<string | null>
  onEditResource?: (resource: VideoResourceDetail) => void
  onSetPrimaryResource?: (resourceId: number) => void
  onSplitResource?: (resource: VideoResourceDetail) => void
  onMoveResource?: (resource: VideoResourceDetail) => void
  onRemoveResource?: (resource: VideoResourceDetail) => void
  onAddResource: () => void
}): JSX.Element {
  const multiResources = video.resources.length > 1

  return (
    <div className={styles.sections}>
      <DetailSection>
        <DetailSectionHead>
          <DetailSectionTitle grow>影片资源</DetailSectionTitle>
          <DetailSectionActions>
            <DetailSectionCount>{video.resources.length} 个</DetailSectionCount>
            <DetailIconButton
              compact
              icon={<Link2 {...UI_ICON} />}
              label="添加资源"
              onClick={onAddResource}
            />
          </DetailSectionActions>
        </DetailSectionHead>
        {video.resources.length > 0 ? (
          <div className={styles.files}>
            {video.resources.map((resource) =>
              resource.kind === 'local' ? (
                <VideoLocalResourceRow
                  key={resource.id}
                  resource={resource}
                  multiResources={multiResources}
                  onOpenResource={onOpenResource}
                  onBuiltinResource={onBuiltinResource}
                  onRevealResource={onRevealResource}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                  onMoveResource={onMoveResource}
                  onEditResource={onEditResource}
                  onRemoveResource={onRemoveResource}
                />
              ) : (
                <VideoLinkResourceRow
                  key={resource.id}
                  resource={resource}
                  onOpenResource={onOpenResource}
                  onRevealResource={onRevealResource}
                  onReadResourceLocator={onReadResourceLocator}
                  onEditResource={onEditResource}
                  onSetPrimaryResource={onSetPrimaryResource}
                  onSplitResource={onSplitResource}
                  onMoveResource={onMoveResource}
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
      </DetailSection>
    </div>
  )
}
