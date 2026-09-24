import { useEffect, useRef, useState } from 'react'
import { Film, Plus, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { RelatedLinkInput } from '@shared/relatedLinkTypes'
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
import { api, assetUrl } from '../api'
import { mediaLibrarySettingsPath } from '../listView/mediaLibraryRoutes'
import Modal from './Modal'
import SelectControl from './SelectControl'
import { EditFormField, EditFormSection } from './FormPrimitives'
import RelatedLinksEditor, { relatedLinksFromDraft } from './RelatedLinksEditor'
import {
  buildVideoManualImportInput,
  buildVideoResourceImportInput,
  canProbeDirectResourceSize,
  emptyVideoResourceDraft,
  formatVideoResourceLinkCheck,
  normalizeOptionalVideoCode,
  resourceBytesToFormSize,
  type VideoResourceDraft,
  type VideoResourceKindSelection
} from './videoResourceImportForm'
import { VIDEO_RESOURCE_KIND_LABELS } from './videoResourcePresentation'
import Button from './Button'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'
import { mediaLibraryCatalogScope } from '../query/catalogScopes'
import { useClassificationLinkKeys } from './classificationLinkForm'
import styles from './VideoResourceImportModal.module.css'

type PlaybackDraft = VideoResourceDraft & {
  sizeSource: 'initial' | 'manual' | 'detected'
  checkResult: VideoResourceLinkCheckResult | null
  checking: boolean
}

type MatchingVideo = Pick<Video, 'id' | 'code' | 'title' | 'cover_path'>

function emptyPlaybackDraft(): PlaybackDraft {
  return {
    ...emptyVideoResourceDraft(),
    sizeSource: 'manual',
    checkResult: null,
    checking: false
  }
}

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
  const isLibraryImport = !resource && !fixedVideoId
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
  const [links, setLinks] = useState<RelatedLinkInput[]>([])
  const [playbackDrafts, setPlaybackDrafts] = useState<PlaybackDraft[]>([])
  const playbackKeys = useClassificationLinkKeys(0)
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [checkResult, setCheckResult] = useState<VideoResourceLinkCheckResult | null>(null)
  const [targetValue, setTargetValue] = useState(fixedVideoId ? `existing:${fixedVideoId}` : 'new')
  const [matchingVideos, setMatchingVideos] = useState<MatchingVideo[]>([])
  const [loadingTargets, setLoadingTargets] = useState(false)
  const checkRequestRef = useRef(0)
  const draftCheckRequestRef = useRef(new Map<string, number>())
  const isStrmManaged = Boolean(resource?.strm_source_path)

  const inferredKind = inferVideoResourceKind(url)
  const inferredKindLabel = VIDEO_RESOURCE_KIND_LABELS[inferredKind]
  const canCheckLink = canProbeDirectResourceSize(kind, url)
  const hasRelatedLinks = relatedLinksFromDraft(links).length > 0
  const hasResourceUrl = isLibraryImport
    ? playbackDrafts.some((draft) => draft.url.trim())
    : Boolean(url.trim())
  const existingNeedsPayload =
    isLibraryImport &&
    targetValue.startsWith('existing:') &&
    !hasResourceUrl &&
    !hasRelatedLinks

  useEffect(() => {
    if (resource || fixedVideoId) return
    const normalized = normalizeOptionalVideoCode(code)
    setTargetValue('new')
    if (!normalized) {
      setMatchingVideos([])
      setLoadingTargets(false)
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

  const patchPlaybackDraft = (index: number, patch: Partial<PlaybackDraft>): void => {
    setPlaybackDrafts((current) =>
      current.map((draft, itemIndex) => (itemIndex === index ? { ...draft, ...patch } : draft))
    )
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

  const checkDraftLink = async (index: number, key: string): Promise<void> => {
    const draft = playbackDrafts[index]
    if (!draft) return
    const requestId = (draftCheckRequestRef.current.get(key) ?? 0) + 1
    draftCheckRequestRef.current.set(key, requestId)
    setError('')
    patchPlaybackDraft(index, { checking: true })
    try {
      const result = await api.videos.checkResourceLink(draft.url)
      if (draftCheckRequestRef.current.get(key) !== requestId) return
      const sizePatch: Partial<PlaybackDraft> = { checking: false, checkResult: result }
      if (result.sizeBytes) {
        const converted = resourceBytesToFormSize(result.sizeBytes)
        sizePatch.size = converted.value
        sizePatch.sizeUnit = converted.unit
        sizePatch.sizeSource = 'detected'
      } else if (draft.sizeSource === 'detected') {
        sizePatch.size = ''
        sizePatch.sizeSource = 'manual'
      }
      patchPlaybackDraft(index, sizePatch)
    } catch (reason) {
      if (draftCheckRequestRef.current.get(key) !== requestId) return
      patchPlaybackDraft(index, {
        checking: false,
        checkResult: { ok: false, error: String((reason as Error).message ?? reason) }
      })
    }
  }

  const resolveTarget = (): VideoResourceImportTarget => {
    if (fixedVideoId) return { kind: 'existing', videoId: fixedVideoId }
    if (targetValue === 'new') return { kind: 'new' }
    if (targetValue.startsWith('existing:')) {
      return { kind: 'existing', videoId: Number(targetValue.slice('existing:'.length)) }
    }
    throw new Error('请选择要归入的影片，或明确新建影片')
  }

  const save = async (): Promise<void> => {
    setError('')
    let payload: Parameters<typeof api.videos.importLinkResource>[0] | null = null
    let updatePayload: Parameters<typeof api.videos.updateLinkResource>[3] | null = null
    try {
      if (resource) {
        const input = buildVideoResourceImportInput({
          code,
          url,
          kind,
          displayName,
          size,
          sizeUnit
        })
        updatePayload = {
          url: input.url,
          kind: input.kind,
          displayName: input.displayName,
          sizeBytes: input.sizeBytes
        }
      } else {
        const target = resolveTarget()
        payload = {
          ...(isLibraryImport
            ? buildVideoManualImportInput({
                code,
                resources: playbackDrafts,
                links
              })
            : buildVideoResourceImportInput({
                code,
                url,
                kind,
                displayName,
                size,
                sizeUnit
              })),
          libraryId,
          target
        }
      }
    } catch (reason) {
      setError(String((reason as Error).message ?? reason))
      return
    }
    setSaving(true)
    try {
      if (resource && updatePayload) {
        onUpdated?.(
          await api.videos.updateLinkResource(
            libraryId,
            resource.video_id,
            resource.id,
            updatePayload
          )
        )
        return
      }
      if (payload) onImported?.(await api.videos.importLinkResource(payload))
    } catch (reason) {
      setError(String((reason as Error).message ?? reason))
    } finally {
      setSaving(false)
    }
  }

  const resourceUrlHint = isStrmManaged
    ? '链接由 STRM 源文件管理；请修改源文件内容并重新扫描。视频直链可尝试读取文件大小，不代表可以播放。'
    : '支持 HTTP/HTTPS、Magnet 与 ED2K。仅视频直链可尝试读取大小；网页链接无法探测，也不代表可以播放。'

  const resourceFields = (
    <>
      <EditFormField label="资源链接" htmlFor="resource-url" span={2} hint={resourceUrlHint}>
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
              aria-label="尝试读取直链文件大小，不验证能否播放"
              onClick={() => void checkLink()}
            >
              {checking ? '读取中…' : '读取大小'}
            </Button>
          ) : null}
        </div>
        {checkResult ? (
          <span className={`video-resource-check ${checkResult.ok ? 'is-success' : 'is-error'}`}>
            {formatVideoResourceLinkCheck(checkResult)}
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
      <EditFormField label="文件大小" htmlFor="resource-size" span={2} hint="可选；视频直链读取到大小后会自动填入。">
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
    </>
  )

  const draftChecking = playbackDrafts.some((draft) => draft.checking)
  const normalizedCode = normalizeOptionalVideoCode(code)

  return (
    <Modal
      title={resource ? '编辑影片资源' : isLibraryImport ? '添加影片' : '导入影片资源'}
      subtitle={
        resource
          ? `更新 ${fixedCode ?? code} 的链接资源`
          : fixedCode
            ? `追加到 ${fixedCode}`
            : undefined
      }
      hint={
        isLibraryImport ? (
          <>
            登记番号，可选添加链接，不会扫描本地文件。扫描请到{' '}
            <Link
              className={styles.hintLink}
              to={mediaLibrarySettingsPath(libraryId, 'sources')}
              onClick={onCancel}
            >
              设置 → 来源与扫描
            </Link>
            ，添加目录后「扫描并导入」。
          </>
        ) : undefined
      }
      size="md"
      className={isLibraryImport ? styles.libraryDialog : ''}
      bodyClassName={isLibraryImport ? styles.libraryBody : ''}
      bodyOverflow={isLibraryImport ? 'hidden' : 'auto'}
      confirmText={
        saving ? '保存中…' : resource ? '保存' : isLibraryImport
          ? targetValue === 'new' ? '添加影片' : '添加到所选影片'
          : '导入'
      }
      confirmDisabled={
        saving ||
        checking ||
        draftChecking ||
        (!resource && !code.trim()) ||
        (isLibraryImport && !targetValue) ||
        existingNeedsPayload ||
        (!resource && Boolean(fixedVideoId) && !hasResourceUrl) ||
        (Boolean(resource) && !hasResourceUrl && !isStrmManaged)
      }
      busy={saving}
      onConfirm={() => void save()}
      onCancel={onCancel}
    >
      <div className={isLibraryImport ? styles.form : 'entity-edit-form'}>
        <div className={isLibraryImport ? styles.identityPane : 'entity-edit-fields video-resource-import-grid'}>
          <EditFormField
            label="影片番号"
            htmlFor="resource-code"
            span={2}
            hint={isLibraryImport ? '必填。可先建无资源影片。' : undefined}
          >
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
          {isLibraryImport ? (
            <EditFormField
              label="归入影片"
              htmlFor="resource-target-new"
              span={2}
              hint="同番号可对应多部影片；默认新建。"
            >
              <div className={styles.targets} role="listbox" aria-label="归入影片">
                <button
                  type="button"
                  id="resource-target-new"
                  className={`${styles.target}${targetValue === 'new' ? ` ${styles.selected}` : ''}`}
                  role="option"
                  aria-selected={targetValue === 'new'}
                  aria-pressed={targetValue === 'new'}
                  disabled={saving}
                  onClick={() => setTargetValue('new')}
                >
                  <span className={styles.cover}>
                    <Film {...UI_ICON_SM} aria-hidden />
                  </span>
                  <span className={styles.copy}>
                    <span className={styles.code}>新建影片</span>
                    <span className={styles.title}>创建独立条目</span>
                  </span>
                </button>
                {matchingVideos.map((video) => {
                  const value = `existing:${video.id}`
                  const cover = assetUrl(video.cover_path, 320)
                  return (
                    <button
                      key={video.id}
                      type="button"
                      className={`${styles.target}${targetValue === value ? ` ${styles.selected}` : ''}`}
                      role="option"
                      aria-selected={targetValue === value}
                      aria-pressed={targetValue === value}
                      disabled={saving}
                      title={video.title ?? video.code}
                      onClick={() => setTargetValue(value)}
                    >
                      <span className={styles.cover}>
                        {cover ? (
                          <img className={styles.coverImage} src={cover} alt="" draggable={false} />
                        ) : (
                          <Film {...UI_ICON_SM} aria-hidden />
                        )}
                      </span>
                      <span className={styles.copy}>
                        <span className={styles.code}>{video.code}</span>
                        <span className={styles.title}>
                          {video.title?.trim() || `影片 #${video.id}`}
                        </span>
                      </span>
                    </button>
                  )
                })}
                {normalizedCode && loadingTargets ? (
                  <p className={styles.status}>正在查找同番号影片…</p>
                ) : null}
                {normalizedCode && !loadingTargets && matchingVideos.length === 0 ? (
                  <p className={styles.status}>没有同番号影片，将新建条目。</p>
                ) : null}
                {!normalizedCode ? (
                  <p className={styles.status}>输入番号后显示同番号影片。</p>
                ) : null}
              </div>
            </EditFormField>
          ) : null}
          {!isLibraryImport ? resourceFields : null}
        </div>
        {isLibraryImport ? (
          <div className={styles.linksPane}>
            <EditFormSection
              title="资源链接"
              hint="可选。支持直链、网页、Magnet 或 ED2K。仅视频直链可读取大小，网页链接请直接保存。"
            >
              <div className={styles.resourceList}>
                {playbackDrafts.map((draft, index) => {
                  const key = playbackKeys.linkKeys[index] ?? `resource-${index}`
                  const draftKind = inferVideoResourceKind(draft.url)
                  const draftCanCheck = canProbeDirectResourceSize(draft.kind, draft.url)
                  return (
                    <div className={styles.resourceCard} key={key}>
                      <div className={styles.resourceUrlRow}>
                        <input
                          id={`import-resource-${key}-url`}
                          className="text-input"
                          value={draft.url}
                          placeholder="https://…"
                          disabled={saving}
                          aria-label={`资源 ${index + 1} 链接`}
                          onChange={(event) =>
                            patchPlaybackDraft(index, {
                              url: event.target.value,
                              checkResult: null,
                              checking: false,
                              ...(draft.sizeSource === 'detected'
                                ? { size: '', sizeSource: 'manual' as const }
                                : {})
                            })
                          }
                        />
                        {draftCanCheck ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={draft.checking || saving || !draft.url.trim()}
                            aria-label={`尝试读取资源 ${index + 1} 的文件大小，不验证能否播放`}
                            onClick={() => void checkDraftLink(index, key)}
                          >
                            {draft.checking ? '读取中…' : '读取大小'}
                          </Button>
                        ) : null}
                        <IconButton
                          size="sm"
                          tone="danger"
                          icon={<Trash2 {...UI_ICON_SM} aria-hidden />}
                          label={`删除资源链接 ${index + 1}`}
                          disabled={saving}
                          onClick={() => {
                            setPlaybackDrafts((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index)
                            )
                            playbackKeys.removeLinkKey(index)
                          }}
                        />
                      </div>
                      <div className={styles.resourceMetaRow}>
                        <SelectControl
                          className="form-control-full"
                          value={draft.kind}
                          aria-label={`资源 ${index + 1} 类型`}
                          disabled={saving}
                          onChange={(event) =>
                            patchPlaybackDraft(index, {
                              kind: event.target.value as VideoResourceKindSelection
                            })
                          }
                        >
                          <option value="auto">
                            自动识别（{VIDEO_RESOURCE_KIND_LABELS[draftKind]}）
                          </option>
                          <option value="direct">{VIDEO_RESOURCE_KIND_LABELS.direct}</option>
                          <option value="web">{VIDEO_RESOURCE_KIND_LABELS.web}</option>
                        </SelectControl>
                        <input
                          className="text-input"
                          value={draft.displayName}
                          placeholder="展示名称"
                          aria-label={`资源 ${index + 1} 展示名称`}
                          disabled={saving}
                          onChange={(event) =>
                            patchPlaybackDraft(index, { displayName: event.target.value })
                          }
                        />
                        <div className="video-resource-size-control">
                          <input
                            className="text-input"
                            type="number"
                            min="0"
                            step="any"
                            value={draft.size}
                            placeholder="大小"
                            aria-label={`资源 ${index + 1} 文件大小`}
                            disabled={saving}
                            onChange={(event) =>
                              patchPlaybackDraft(index, {
                                size: event.target.value,
                                sizeSource: 'manual',
                                checkResult: null
                              })
                            }
                          />
                          <SelectControl
                            value={draft.sizeUnit}
                            disabled={saving}
                            aria-label={`资源 ${index + 1} 大小单位`}
                            onChange={(event) =>
                              patchPlaybackDraft(index, {
                                sizeUnit: event.target.value as VideoResourceSizeUnit,
                                sizeSource: 'manual',
                                checkResult: null
                              })
                            }
                          >
                            <option value="MB">MB</option>
                            <option value="GB">GB</option>
                            <option value="TB">TB</option>
                          </SelectControl>
                        </div>
                      </div>
                      {draft.checkResult ? (
                        <span
                          className={`video-resource-check ${draft.checkResult.ok ? 'is-success' : 'is-error'}`}
                        >
                          {formatVideoResourceLinkCheck(draft.checkResult)}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={styles.addButton}
                  disabled={saving}
                  onClick={() => {
                    setPlaybackDrafts((current) => [...current, emptyPlaybackDraft()])
                    playbackKeys.appendLinkKey()
                  }}
                >
                  <Plus {...UI_ICON_SM} />
                  添加链接
                </Button>
              </div>
            </EditFormSection>
            <RelatedLinksEditor
              disabled={saving}
              links={links}
              hint="可选。商品页、资料页等 HTTP/HTTPS 地址，不会当作播放资源。"
              onChange={setLinks}
            />
          </div>
        ) : null}
      </div>
      {error ? <div className="form-error-banner">{error}</div> : null}
    </Modal>
  )
}
