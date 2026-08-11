import { useRef, useState } from 'react'
import type {
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResource,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import { inferVideoResourceKind } from '@shared/videoResourceLinks'
import { api } from '../api'
import Modal from './Modal'
import { EditFormField } from './FormPrimitives'
import {
  buildVideoResourceImportInput,
  resourceBytesToFormSize,
  type VideoResourceKindSelection
} from './videoResourceImportForm'
import { VIDEO_RESOURCE_KIND_LABELS } from './videoResourcePresentation'

export default function VideoResourceImportModal({
  fixedCode,
  resource,
  onCancel,
  onImported,
  onUpdated
}: {
  fixedCode?: string
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
  const checkRequestRef = useRef(0)

  const inferredKind = inferVideoResourceKind(url)
  const inferredKindLabel = VIDEO_RESOURCE_KIND_LABELS[inferredKind]
  const canCheckLink = inferredKind === 'direct' || inferredKind === 'web'

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
        const updated = await api.videos.updateLinkResource(resource.video_id, resource.id, {
          url: input.url,
          kind: input.kind,
          displayName: input.displayName,
          sizeBytes: input.sizeBytes
        })
        onUpdated?.(updated)
      } else {
        onImported?.(await api.videos.importLinkResource(input))
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
      confirmDisabled={saving || checking}
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
        <EditFormField
          label="资源链接"
          htmlFor="resource-url"
          span={2}
          hint="支持 HTTP/HTTPS、Magnet 与 ED2K；仅 HTTP/HTTPS 可检测可访问性。"
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
              disabled={saving}
              autoFocus={Boolean(fixedCode)}
              placeholder="https://…"
            />
            {canCheckLink ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={checking || saving || !url.trim()}
                onClick={() => void checkLink()}
              >
                {checking ? '检测中…' : '检测链接'}
              </button>
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
        <EditFormField label="资源类型" htmlFor="resource-kind">
          <select
            id="resource-kind"
            className="select form-control-full"
            value={kind}
            onChange={(event) => setKind(event.target.value as VideoResourceKindSelection)}
            disabled={saving}
          >
            <option value="auto">自动识别（{inferredKindLabel}）</option>
            <option value="direct">{VIDEO_RESOURCE_KIND_LABELS.direct}</option>
            <option value="web">{VIDEO_RESOURCE_KIND_LABELS.web}</option>
          </select>
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
            <select
              className="select"
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
            </select>
          </div>
        </EditFormField>
      </div>
      {error ? <div className="form-error-banner">{error}</div> : null}
    </Modal>
  )
}
