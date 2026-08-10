import { useState } from 'react'
import type {
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResourceSizeUnit
} from '@shared/videoTypes'
import { inferHttpVideoResourceKind } from '@shared/videoResourceLinks'
import { api } from '../api'
import Modal from './Modal'
import { EditFormField } from './FormPrimitives'
import {
  buildVideoResourceImportInput,
  resourceBytesToFormSize,
  type VideoResourceKindSelection
} from './videoResourceImportForm'

export default function VideoResourceImportModal({
  fixedCode,
  onCancel,
  onImported
}: {
  fixedCode?: string
  onCancel: () => void
  onImported: (result: VideoResourceImportResult) => void
}): JSX.Element {
  const [code, setCode] = useState(fixedCode ?? '')
  const [url, setUrl] = useState('')
  const [kind, setKind] = useState<VideoResourceKindSelection>('auto')
  const [displayName, setDisplayName] = useState('')
  const [size, setSize] = useState('')
  const [sizeUnit, setSizeUnit] = useState<VideoResourceSizeUnit>('GB')
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [checkResult, setCheckResult] = useState<VideoResourceLinkCheckResult | null>(null)

  const inferredKind = inferHttpVideoResourceKind(url)

  const checkLink = async (): Promise<void> => {
    setError('')
    setChecking(true)
    try {
      const result = await api.videos.checkResourceLink(url)
      setCheckResult(result)
      if (result.sizeBytes) {
        const converted = resourceBytesToFormSize(result.sizeBytes)
        setSize(converted.value)
        setSizeUnit(converted.unit)
      }
    } catch (reason) {
      setCheckResult({ ok: false, error: String((reason as Error).message ?? reason) })
    } finally {
      setChecking(false)
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
      onImported(await api.videos.importLinkResource(input))
    } catch (reason) {
      setError(String((reason as Error).message ?? reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="导入影片资源"
      subtitle={fixedCode ? `追加到 ${fixedCode}` : '通过链接创建影片或追加资源'}
      size="md"
      confirmText={saving ? '导入中…' : '导入'}
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
          hint="仅支持 HTTP/HTTPS。检测失败不会阻止导入。"
        >
          <div className="video-resource-url-control">
            <input
              id="resource-url"
              className="text-input form-control-full"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                setCheckResult(null)
              }}
              disabled={saving}
              autoFocus={Boolean(fixedCode)}
              placeholder="https://…"
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={checking || saving || !url.trim()}
              onClick={() => void checkLink()}
            >
              {checking ? '检测中…' : '检测链接'}
            </button>
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
            <option value="auto">自动识别（{inferredKind === 'direct' ? '视频直链' : '网页链接'}）</option>
            <option value="direct">视频直链</option>
            <option value="web">网页链接</option>
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
              onChange={(event) => setSize(event.target.value)}
              disabled={saving}
              placeholder="未设置"
            />
            <select
              className="select"
              value={sizeUnit}
              onChange={(event) => setSizeUnit(event.target.value as VideoResourceSizeUnit)}
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
