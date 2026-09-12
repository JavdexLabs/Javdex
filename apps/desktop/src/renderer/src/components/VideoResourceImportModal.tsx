import { useEffect, useRef, useState } from 'react'
import type {
  Video,
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResource,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { inferVideoResourceKind } from '@shared/videoResourceLinks'
import { api } from '../api'
import Modal from './Modal'
import SelectControl from './SelectControl'
import { EditFormField } from './FormPrimitives'
import {
  buildVideoResourceImportInput,
  normalizeOptionalVideoCode,
  resourceBytesToFormSize,
  type VideoResourceKindSelection
} from './videoResourceImportForm'
import { VIDEO_RESOURCE_KIND_LABELS } from './videoResourcePresentation'
import Button from './Button'
import { mediaLibraryCatalogScope } from '../query/catalogScopes'

export default function VideoResourceImportModal({
  libraryId,
  fixedCode,
  fixedVideoId,
  resource,
  onCancel,
  onImported,
  onUpdated
}: {
  libraryId: number
  fixedCode?: string
  fixedVideoId?: number
  resource?: VideoResource
  onCancel: () => void
  onImported?: (result: VideoResourceImportResult) => void
  onUpdated?: (resource: VideoResource) => void
}): JSX.Element {
  const [code, setCode] = useState(fixedCode ?? '')
  const [url, setUrl] = useState(resource?.locator ?? '')
  const [kind, setKind] = useState<VideoResourceKindSelection>(
    resource?.kind === 'direct' || resource?.kind === 'web' ? resource.kind : 'auto'
  )
  const [displayName, setDisplayName] = useState(resource?.display_name ?? '')
  const initialSize = resource?.size_bytes ? resourceBytesToFormSize(resource.size_bytes) : null
  const [size, setSize] = useState(initialSize?.value ?? '')
  const [sizeUnit, setSizeUnit] = useState<VideoResourceSizeUnit>(initialSize?.unit ?? 'GB')
  const [sizeSource, setSizeSource] = useState<'initial' | 'manual' | 'detected'>(
    initialSize ? 'initial' : 'manual'
  )
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [checkResult, setCheckResult] = useState<VideoResourceLinkCheckResult | null>(null)
  const [targetValue, setTargetValue] = useState(fixedVideoId ? `existing:${fixedVideoId}` : '')
  const [matchingVideos, setMatchingVideos] = useState<Array<Pick<Video, 'id' | 'code' | 'title'>>>([])
  const [loadingTargets, setLoadingTargets] = useState(false)
  const checkRequestRef = useRef(0)
  const isStrmManaged = Boolean(resource?.strm_source_path)

  const inferredKind = inferVideoResourceKind(url)
  const inferredKindLabel = VIDEO_RESOURCE_KIND_LABELS[inferredKind]
  const canCheckLink = inferredKind === 'direct' || inferredKind === 'web'

  useEffect(() => {
    if (resource || fixedVideoId) return
    const normalized = normalizeOptionalVideoCode(code)
    setTargetValue('')
    if (!normalized) {
      setMatchingVideos([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      setLoadingTargets(true)
      void api.videos
        .list(mediaLibraryCatalogScope(libraryId), {
          search: normalized,
          limit: 100,
          offset: 0
        })
        .then((result) => {
          if (cancelled) return
          setMatchingVideos(
            result.items.filter((video) => normalizeVideoCode(video.code) === normalized)
          )
        })
        .catch((reason) => {
          if (!cancelled) setError(String((reason as Error).message ?? reason))
        })
        .finally(() => {
          if (!cancelled) setLoadingTargets(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [code, fixedVideoId, libraryId, resource])

  const invalidateLinkCheck = (): void => {
    checkRequestRef.current += 1
    setChecking(false)
    setCheckResult(null)
  }

  const checkLink = async (): Promise<void> => {
    const requestId = ++checkRequestRef.current
    const requestedUrl = url
    setError('')
    setChecking(true)
    try {
      const result = await api.videos.checkResourceLink(requestedUrl)
      if (requestId !== checkRequestRef.current) return
      setCheckResult(result)
      if (result.sizeBytes) {
        const converted = resourceBytesToFormSize(result.sizeBytes)
        setSize(converted.value)
        setSizeUnit(converted.unit)
        setSizeSource('detected')
      } else if (sizeSource === 'detected') {
        setSize('')
        setSizeSource('manual')
      }
    } catch (reason) {
      if (requestId !== checkRequestRef.current) return
      setCheckResult({ ok: false, error: String((reason as Error).message ?? reason) })
    } finally {
      if (requestId === checkRequestRef.current) setChecking(false)
    }
  }

  const save = async (): Promise<void> => {
    setError('')
    let input
    try {
      input = buildVideoResourceImportInput({ code, url, kind, displayName, size, sizeUnit })
    } catch (reason) {
      setError(String((reason as Error).message ?? reason))
      return
    }
    setSaving(true)
    try {
      if (resource) {
        const updated = await api.videos.updateLinkResource(
          libraryId,
          resource.video_id,
          resource.id,
          {
            url: input.url,
            kind: input.kind,
            displayName: input.displayName,
            sizeBytes: input.sizeBytes
          }
        )
        onUpdated?.(updated)
      } else {
        let target: VideoResourceImportTarget
        if (fixedVideoId) target = { kind: 'existing', videoId: fixedVideoId }
        else if (targetValue === 'new') target = { kind: 'new' }
        else if (targetValue.startsWith('existing:')) {
          target = { kind: 'existing', videoId: Number(targetValue.slice('existing:'.length)) }
        } else {
          throw new Error('请选择资源要归入的影片，或明确新建影片')
        }
        onImported?.(
          await api.videos.importLinkResource({ ...input, libraryId, target })
        )
      }
    } catch (reason) {
      setError(String((reason as Error).message ?? reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={resource ? '编辑影片资源' : '导入影片资源'}
      subtitle={resource ? `更新 ${fixedCode ?? code} 的链接资源` : fixedCode ? `追加到 ${fixedCode}` : '通过链接创建影片或追加资源'}

      size="md"
      confirmText={saving ? '保存中…' : resource ? '保存' : '导入'}
      confirmDisabled={saving || checking || (!resource && !fixedVideoId && !targetValue)}
      busy={saving}
      onConfirm={() => void save()}
      onCancel={onCancel}
    >
      <div className="entity-edit-fields video-resource-import-grid">
        <EditFormField label="影片番号" htmlFor="resource-code" span={2}>
          <input
            id="resource-code"
            className="text-input form-control-full"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={Boolean(fixedCode) || saving}
            autoFocus={!fixedCode}
            placeholder="例如 ABC-123"
          />
        </EditFormField>
        {!resource && !fixedVideoId ? (
          <EditFormField
            label="归入影片"
            htmlFor="resource-target"
            span={2}
            hint="同番号可以对应多部影片，必须明确选择目标。"
          >
            <SelectControl
              id="resource-target"
              className="form-control-full"
              value={targetValue}
              onChange={(event) => setTargetValue(event.target.value)}
              disabled={saving || loadingTargets || !code.trim()}
            >
              <option value="">{loadingTargets ? '正在查找同番号影片…' : '请选择目标'}</option>
              {matchingVideos.map((video) => (
                <option key={video.id} value={`existing:${video.id}`}>
                  归入 ID {video.id} · {video.code}{video.title ? ` · ${video.title}` : ''}
                </option>
              ))}
              <option value="new">新建一部独立影片</option>
            </SelectControl>
          </EditFormField>
        ) : null}
        <EditFormField
          label="资源链接"
          htmlFor="resource-url"
          span={2}
          hint={
            isStrmManaged
              ? '链接由 STRM 源文件管理；请修改源文件内容并重新扫描。HTTP/HTTPS 链接仍可检测可访问性。'
              : '支持 HTTP/HTTPS、Magnet 与 ED2K；仅 HTTP/HTTPS 可检测可访问性。'
          }
        >
          <div className="video-resource-url-control">
            <input
              id="resource-url"
              className="text-input form-control-full"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                if (sizeSource === 'detected') {
                  setSize('')
                  setSizeSource('manual')
                }
                invalidateLinkCheck()
              }}
              disabled={saving || isStrmManaged}
              autoFocus={Boolean(fixedCode)}
              placeholder="https://…"
            />
            {canCheckLink ? (
              <Button
                type="button"

                size="sm"
                disabled={checking || saving || !url.trim()}
                onClick={() => void checkLink()}
              >
                {checking ? '检测中…' : '检测链接'}
              </Button>
            ) : null}
          </div>
          {checkResult ? (
            <span className={`video-resource-check ${checkResult.ok ? 'is-success' : 'is-error'}`}>
              {checkResult.ok
                ? `链接可访问${checkResult.status ? ` · HTTP ${checkResult.status}` : ''}${checkResult.sizeBytes ? ' · 已读取文件大小' : ''}`
                : checkResult.error ?? '链接检测失败'}
            </span>
          ) : null}
        </EditFormField>
        <EditFormField
          label="资源类型"
          htmlFor="resource-kind"
          hint={isStrmManaged ? '资源类型随 STRM 目标自动同步。' : undefined}
        >
          <SelectControl
            id="resource-kind"
            className="form-control-full"
            value={kind}
            onChange={(event) => setKind(event.target.value as VideoResourceKindSelection)}
            disabled={saving || isStrmManaged}
          >
            <option value="auto">自动识别（{inferredKindLabel}）</option>
            <option value="direct">{VIDEO_RESOURCE_KIND_LABELS.direct}</option>
            <option value="web">{VIDEO_RESOURCE_KIND_LABELS.web}</option>
          </SelectControl>
        </EditFormField>
        <EditFormField label="展示名称" htmlFor="resource-name" hint="可选，不填写时显示脱敏域名或路径。">
          <input
            id="resource-name"
            className="text-input form-control-full"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={saving}
            placeholder="可选"
          />
        </EditFormField>
        <EditFormField label="文件大小" htmlFor="resource-size" span={2} hint="可选；视频直链检测到大小后会自动填入。">
          <div className="video-resource-size-control">
            <input
              id="resource-size"
              className="text-input"
              type="number"
              min="0"
              step="any"
              value={size}
              onChange={(event) => {
                setSize(event.target.value)
                setSizeSource('manual')
                invalidateLinkCheck()
              }}
              disabled={saving}
              placeholder="未设置"
            />
            <SelectControl
              value={sizeUnit}
              onChange={(event) => {
                setSizeUnit(event.target.value as VideoResourceSizeUnit)
                setSizeSource('manual')
                invalidateLinkCheck()
              }}
              disabled={saving}
              aria-label="大小单位"
            >
              <option value="MB">MB</option>
              <option value="GB">GB</option>
              <option value="TB">TB</option>
            </SelectControl>
          </div>
        </EditFormField>
      </div>
      {error ? <div className="form-error-banner">{error}</div> : null}
    </Modal>
  )
}
