import { useActressGalleryPage } from '../hooks/useActressGalleryPage'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActressGalleryAsset } from '@shared/actressTypes'
import { useActressVideoPage } from '../hooks/useActressVideoPage'
import { DEFAULT_AVATAR_FACE_RATIO } from '@shared/avatarFaceScale'
import {
  DEFAULT_AVATAR_CENTERING_MODE,
  type AvatarCenteringMode
} from '@shared/avatarCentering'
import {
  createAvatarCropV1,
  parseAvatarCrop,
  scaleAvatarCropToViewSize,
  type ActressAvatarCommit,
  type AvatarCropV1
} from '@shared/avatarCrop'
import { assetUrl, api } from '../api'
import {
  analyzeAvatarBitmap,
  cancelPendingAvatarAutoCrop,
  disposeAvatarAutoCropWorker
} from '../avatarAutoCrop/service'
import { createAvatarAnalysisBitmap } from '../avatarAutoCrop/image'
import type { AvatarFaceCandidate } from '../avatarAutoCrop/types'
import { useHorizontalDragScroll } from '../hooks/useHorizontalDragScroll'
import { useToast } from './Toast'
import {
  AVATAR_VIEW_SIZE,
  clampCropOffset,
  exportAvatarCrop,
  getCropImageLayout,
  getDefaultCropTransform,
  getSavedAvatarCropTransform,
  getSmartAvatarCropTransform,
  isDefaultCropTransform
} from '../utils/avatarCrop'
import Button from './Button'

type SourceTab = 'current' | 'local' | 'cover' | 'gallery'

interface Props {
  displayUrl: string | null
  sourceUrl: string | null
  savedCrop: AvatarCropV1 | null
  actressId: number
  onAvatarChange: (commit: ActressAvatarCommit | null) => void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

function isCurrentSourceFallbackAllowed(
  url: string,
  sourceUrl: string | null,
  displayUrl: string | null
): boolean {
  return Boolean(sourceUrl && displayUrl && url === sourceUrl && displayUrl !== sourceUrl)
}

async function fingerprintFromUrl(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fingerprint image (${res.status})`)
  const buf = await res.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * Prefer raw media:// bytes so sourceAssetPath fingerprints match main-process reads.
 * Fall back to re-encoded JPEG when fetch is unavailable for the custom protocol.
 */
async function resolveLibrarySourceFingerprint(url: string): Promise<{
  fingerprint: string
  sourceImageBase64?: string
}> {
  try {
    return { fingerprint: await fingerprintFromUrl(url) }
  } catch (err) {
    console.warn('[ActressAvatarEditor] media fetch fingerprint failed, using JPEG fallback', err)
    const blob = await imageUrlToJpegBlob(url)
    return {
      fingerprint: await fingerprintFromBlob(blob),
      sourceImageBase64: await blobToBase64(blob)
    }
  }
}

async function fingerprintFromBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

function gallerySrc(asset: ActressGalleryAsset): string | null {
  return assetUrl(asset.local_path) ?? asset.remote_url
}

function probeImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = new Image()
    const finish = (): void => {
      if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) {
        reject(new Error('Invalid image dimensions'))
        return
      }
      resolve({ width: probe.naturalWidth, height: probe.naturalHeight })
    }
    probe.onload = finish
    probe.onerror = () => reject(new Error('Failed to load image'))
    probe.src = url
    if (probe.complete) finish()
  })
}

function imageUrlToJpegBlob(url: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const width = img.naturalWidth
      const height = img.naturalHeight
      if (width <= 0 || height <= 0) {
        reject(new Error('Invalid image dimensions'))
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      try {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob)
            else reject(new Error('Failed to encode image'))
          },
          'image/jpeg',
          0.92
        )
      } catch (error) {
        reject(error)
      }
    }
    img.onerror = () => reject(new Error('Failed to load image'))
    img.crossOrigin = 'anonymous'
    img.src = url
  })
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const base64 = result.includes(',') ? result.split(',')[1] : result
      resolve(base64 || '')
    }
    reader.onerror = () => reject(new Error('Failed to read image'))
    reader.readAsDataURL(blob)
  })
}

/** Circular preview, square export; restores saved crop when editing current source. */
export default function ActressAvatarEditor({
  displayUrl,
  sourceUrl,
  savedCrop,
  actressId,
  onAvatarChange
}: Props): JSX.Element {
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const loadSeqRef = useRef(0)
  const previewSeqRef = useRef(0)
  const autoCropSeqRef = useRef(0)
  const initialCropRef = useRef<AvatarCropV1 | null>(null)
  const galleryScroll = useHorizontalDragScroll()
  const coverScroll = useHorizontalDragScroll()

  const covers = useActressVideoPage(actressId, true)
  const coverVideos = covers.data?.videos ?? []
  const onCoverRange = covers.window.onVisibleRange
  const onCoverScroll = (event: { currentTarget: { scrollLeft: number; clientWidth: number; clientHeight: number; scrollWidth: number } }): void => {
    const { scrollLeft, clientWidth, clientHeight, scrollWidth } = event.currentTarget
    const stride = Math.max(72, clientHeight) + 8
    if (scrollWidth > clientWidth + 8 && scrollLeft + clientWidth >= scrollWidth - 32) {
      onCoverRange(Math.max(coverVideos.length, 1) - 1, coverVideos.length + 59)
      return
    }
    const start = Math.floor(Math.max(0, scrollLeft) / stride)
    const end = Math.ceil((scrollLeft + clientWidth) / stride)
    if (end > start) onCoverRange(start, end)
  }
  useLayoutEffect(() => {
    const el = coverScroll.ref.current
    if (!el || covers.loading || covers.error || coverVideos.length === 0 || coverVideos.length >= covers.total) return
    if (el.scrollWidth <= el.clientWidth + 8) {
      onCoverRange(Math.max(coverVideos.length, 1) - 1, coverVideos.length + 59)
    }
  }, [coverVideos.length, covers.loading, covers.error, covers.total, onCoverRange, coverScroll.ref])
  const photos = useActressGalleryPage(actressId, true)
  const galleryItems = photos.data?.items ?? []

  const editableSourceUrl = sourceUrl || displayUrl
  const hasOriginalSource = Boolean(sourceUrl)

  const defaultTab = useMemo((): SourceTab => {
    if (editableSourceUrl) return 'current'
    if (coverVideos.length > 0) return 'cover'
    if (galleryItems.length > 0) return 'gallery'
    return 'local'
  }, [coverVideos.length, editableSourceUrl, galleryItems.length])

  const [activeTab, setActiveTab] = useState<SourceTab>(defaultTab)
  const initialTabResolved = useRef(false)
  useEffect(() => {
    if (!initialTabResolved.current && !covers.loading && !photos.loading) {
      initialTabResolved.current = true
      setActiveTab(defaultTab)
    }
  }, [covers.loading, photos.loading, defaultTab])
  const [editUrl, setEditUrl] = useState<string | null>(null)
  const [activeSourceKey, setActiveSourceKey] = useState<string | null>(null)
  const [baseScale, setBaseScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [metricsReady, setMetricsReady] = useState(false)
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null)
  const [sourceFingerprint, setSourceFingerprint] = useState<string | null>(null)
  const [pendingSourceAssetPath, setPendingSourceAssetPath] = useState<string | null>(null)
  const [pendingSourceImageBase64, setPendingSourceImageBase64] = useState<string | null>(null)
  const [pendingSourceLocalPath, setPendingSourceLocalPath] = useState<string | null>(null)
  const [sourceChanged, setSourceChanged] = useState(false)
  const [legacyNoSource, setLegacyNoSource] = useState(false)
  const [openingSourceKey, setOpeningSourceKey] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [previewSourceSize, setPreviewSourceSize] = useState<{ w: number; h: number } | null>(null)
  const [smartCropping, setSmartCropping] = useState(false)
  const [autoCropCandidates, setAutoCropCandidates] = useState<AvatarFaceCandidate[]>([])
  const [activeAutoCropCandidate, setActiveAutoCropCandidate] = useState<string | null>(null)
  const [autoCropFaceRatio, setAutoCropFaceRatio] = useState(DEFAULT_AVATAR_FACE_RATIO)
  const [autoCropCenteringMode, setAutoCropCenteringMode] =
    useState<AvatarCenteringMode>(DEFAULT_AVATAR_CENTERING_MODE)
  const [autoCropPreserveFullHead, setAutoCropPreserveFullHead] = useState(false)

  const applyTransform = useCallback(
    (
      width: number,
      height: number,
      crop: AvatarCropV1 | null,
      mode: 'restore' | 'default' | 'legacy'
    ) => {
      const defaults = getDefaultCropTransform(width, height, AVATAR_VIEW_SIZE)
      if (mode === 'legacy') {
        const legacy = getSavedAvatarCropTransform(width, height, AVATAR_VIEW_SIZE)
        setBaseScale(legacy.baseScale)
        setZoom(legacy.zoom)
        setOffset({ x: legacy.offsetX, y: legacy.offsetY })
        initialCropRef.current = null
      } else if (crop) {
        const scaled = scaleAvatarCropToViewSize(crop, AVATAR_VIEW_SIZE)
        const clamped = clampCropOffset(
          scaled.offsetX,
          scaled.offsetY,
          width,
          height,
          defaults.baseScale,
          scaled.zoom,
          AVATAR_VIEW_SIZE
        )
        setBaseScale(defaults.baseScale)
        setZoom(scaled.zoom)
        setOffset(clamped)
        initialCropRef.current = createAvatarCropV1({
          sourceFingerprint: scaled.sourceFingerprint,
          zoom: scaled.zoom,
          offsetX: clamped.x,
          offsetY: clamped.y,
          viewSize: AVATAR_VIEW_SIZE,
          outputSize: scaled.outputSize
        })
      } else {
        setBaseScale(defaults.baseScale)
        setZoom(defaults.zoom)
        setOffset({ x: defaults.offsetX, y: defaults.offsetY })
        initialCropRef.current = null
      }
      setImageSize({ w: width, h: height })
      setMetricsReady(true)
    },
    []
  )

  const beginEditSource = useCallback(
    async (input: {
      url: string
      sourceKey: string
      restoreCrop?: AvatarCropV1 | null
      libraryAssetPath?: string | null
      localFile?: File | null
      isCurrent?: boolean
      forceLegacy?: boolean
    }) => {
      const seq = ++loadSeqRef.current
      autoCropSeqRef.current += 1
      cancelPendingAvatarAutoCrop()
      setSmartCropping(false)
      setOpeningSourceKey(input.sourceKey)
      setOpenError(null)
      setAutoCropCandidates([])
      setActiveAutoCropCandidate(null)
      try {
        const { width, height } = await probeImage(input.url)
        if (seq !== loadSeqRef.current) return

        let fingerprint: string
        let nextSourceBase64: string | null = null
        let nextAssetPath: string | null = null
        let nextLocalPath: string | null = null
        let changed = false
        let legacy = false
        let cropToApply: AvatarCropV1 | null = null
        let mode: 'restore' | 'default' | 'legacy' = 'default'
        const canUseCurrentSource = input.isCurrent && hasOriginalSource && !input.forceLegacy

        if (input.localFile) {
          fingerprint = await fingerprintFromBlob(input.localFile)
          try {
            nextLocalPath = api.assets.getPathForFile(input.localFile) || null
          } catch {
            nextLocalPath = null
          }
          if (!nextLocalPath) {
            nextSourceBase64 = await blobToBase64(input.localFile)
          }
          changed = true
        } else if (canUseCurrentSource) {
          // Prefer saved crop fingerprint so we don't need a media:// fetch to open.
          fingerprint =
            input.restoreCrop?.sourceFingerprint || (await fingerprintFromUrl(input.url))
          nextAssetPath = null
          changed = false
          const parsed = parseAvatarCrop(
            input.restoreCrop ? JSON.stringify(input.restoreCrop) : null,
            fingerprint
          )
          cropToApply = parsed
          mode = parsed ? 'restore' : 'default'
        } else if (input.isCurrent && (!hasOriginalSource || input.forceLegacy)) {
          const blob = await imageUrlToJpegBlob(input.url)
          fingerprint = await fingerprintFromBlob(blob)
          nextSourceBase64 = await blobToBase64(blob)
          legacy = true
          mode = 'legacy'
          changed = true
        } else if (input.libraryAssetPath) {
          const resolved = await resolveLibrarySourceFingerprint(input.url)
          fingerprint = resolved.fingerprint
          if (resolved.sourceImageBase64) {
            nextSourceBase64 = resolved.sourceImageBase64
            nextAssetPath = null
          } else {
            nextAssetPath = input.libraryAssetPath
          }
          changed = true
        } else {
          fingerprint = await fingerprintFromUrl(input.url)
          changed = true
        }

        if (seq !== loadSeqRef.current) return

        setEditUrl((prev) => {
          if (prev?.startsWith('blob:') && prev !== input.url) URL.revokeObjectURL(prev)
          return input.url
        })
        setActiveSourceKey(input.sourceKey)
        setSourceFingerprint(fingerprint)
        setPendingSourceAssetPath(nextAssetPath)
        setPendingSourceImageBase64(nextSourceBase64)
        setPendingSourceLocalPath(nextLocalPath)
        setSourceChanged(changed)
        setLegacyNoSource(legacy)
        applyTransform(width, height, cropToApply, mode)
      } catch (err) {
        if (seq !== loadSeqRef.current) return
        if (input.isCurrent && isCurrentSourceFallbackAllowed(input.url, sourceUrl, displayUrl)) {
          await beginEditSource({
            ...input,
            url: displayUrl as string,
            forceLegacy: true
          })
          return
        }
        setOpenError('无法打开该图片进行裁剪，请换一张或稍后重试')
        console.error('[ActressAvatarEditor] failed to open source', err)
      } finally {
        if (seq === loadSeqRef.current) setOpeningSourceKey(null)
      }
    },
    [applyTransform, displayUrl, hasOriginalSource, sourceUrl]
  )

  useEffect(() => {
    const seq = ++previewSeqRef.current
    setPreviewSourceSize(null)
    if (!sourceUrl || !savedCrop) return

    void probeImage(sourceUrl)
      .then(({ width, height }) => {
        if (seq !== previewSeqRef.current) return
        setPreviewSourceSize({ w: width, h: height })
      })
      .catch(() => {
        if (seq !== previewSeqRef.current) return
        setPreviewSourceSize(null)
      })
  }, [savedCrop, sourceUrl])

  useEffect(
    () => () => {
      autoCropSeqRef.current += 1
      disposeAvatarAutoCropWorker()
    },
    []
  )

  const resetTransform = useCallback((): void => {
    if (!imageSize) return
    autoCropSeqRef.current += 1
    cancelPendingAvatarAutoCrop()
    setSmartCropping(false)
    setActiveAutoCropCandidate(null)
    if (initialCropRef.current && sourceFingerprint) {
      applyTransform(imageSize.w, imageSize.h, initialCropRef.current, 'restore')
      return
    }
    if (legacyNoSource) {
      applyTransform(imageSize.w, imageSize.h, null, 'legacy')
      return
    }
    applyTransform(imageSize.w, imageSize.h, null, 'default')
  }, [applyTransform, imageSize, legacyNoSource, sourceFingerprint])

  const clearSource = useCallback((): void => {
    loadSeqRef.current += 1
    autoCropSeqRef.current += 1
    cancelPendingAvatarAutoCrop()
    setSmartCropping(false)
    setEditUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
    setActiveSourceKey(null)
    setMetricsReady(false)
    setImageSize(null)
    setBaseScale(1)
    setOffset({ x: 0, y: 0 })
    setZoom(1)
    setSourceFingerprint(null)
    setPendingSourceAssetPath(null)
    setPendingSourceImageBase64(null)
    setPendingSourceLocalPath(null)
    setSourceChanged(false)
    setLegacyNoSource(false)
    setOpenError(null)
    setAutoCropCandidates([])
    setActiveAutoCropCandidate(null)
    initialCropRef.current = null
    onAvatarChange(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [onAvatarChange])

  const loadCurrentAvatar = useCallback((): void => {
    if (!editableSourceUrl) return
    void beginEditSource({
      url: editableSourceUrl,
      sourceKey: 'current',
      restoreCrop: savedCrop,
      isCurrent: true
    })
  }, [beginEditSource, editableSourceUrl, savedCrop])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    void beginEditSource({
      url: URL.createObjectURL(file),
      sourceKey: 'local',
      localFile: file
    })
  }

  const clampOffset = useCallback(
    (x: number, y: number, zoomValue = zoom): { x: number; y: number } => {
      if (!imageSize) return { x, y }
      return clampCropOffset(
        x,
        y,
        imageSize.w,
        imageSize.h,
        baseScale,
        zoomValue,
        AVATAR_VIEW_SIZE
      )
    },
    [baseScale, imageSize, zoom]
  )

  useEffect(() => {
    const img = imgRef.current
    if (!editUrl || !metricsReady || !img?.naturalWidth || !sourceFingerprint) {
      onAvatarChange(null)
      return
    }
    const displayImageBase64 = exportAvatarCrop(img, offset.x, offset.y, zoom, baseScale)
    if (!displayImageBase64) {
      onAvatarChange(null)
      return
    }
    const crop = createAvatarCropV1({
      sourceFingerprint,
      zoom,
      offsetX: offset.x,
      offsetY: offset.y
    })
    const commit: ActressAvatarCommit = {
      displayImageBase64,
      crop
    }
    if (sourceChanged) {
      if (pendingSourceImageBase64) commit.sourceImageBase64 = pendingSourceImageBase64
      if (pendingSourceAssetPath) commit.sourceAssetPath = pendingSourceAssetPath
      if (pendingSourceLocalPath) commit.sourceLocalPath = pendingSourceLocalPath
    }
    onAvatarChange(commit)
  }, [
    editUrl,
    offset,
    zoom,
    baseScale,
    metricsReady,
    onAvatarChange,
    pendingSourceAssetPath,
    pendingSourceImageBase64,
    pendingSourceLocalPath,
    sourceChanged,
    sourceFingerprint
  ])

  useEffect(() => {
    if (!metricsReady) return
    setOffset((prev) => clampOffset(prev.x, prev.y))
  }, [zoom, baseScale, metricsReady, clampOffset])

  useEffect(() => {
    const node = viewportRef.current
    if (!node || !editUrl || !metricsReady) return

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY > 0 ? -0.08 : 0.08
      setZoom((z) => Math.min(4, Math.max(1, Number((z + delta).toFixed(2)))))
    }

    const blockNativeDrag = (e: Event): void => {
      e.preventDefault()
    }

    node.addEventListener('wheel', onWheel, { passive: false })
    node.addEventListener('dragstart', blockNativeDrag)
    node.addEventListener('selectstart', blockNativeDrag)
    return () => {
      node.removeEventListener('wheel', onWheel)
      node.removeEventListener('dragstart', blockNativeDrag)
      node.removeEventListener('selectstart', blockNativeDrag)
    }
  }, [editUrl, metricsReady])

  useEffect(() => {
    return () => {
      if (editUrl?.startsWith('blob:')) URL.revokeObjectURL(editUrl)
    }
  }, [editUrl])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!editUrl || !metricsReady) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: offset.x,
      originY: offset.y
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.preventDefault()
    setOffset(
      clampOffset(drag.originX + (e.clientX - drag.startX), drag.originY + (e.clientY - drag.startY))
    )
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null
    }
  }

  const applyAutoCropCandidate = (
    candidate: AvatarFaceCandidate,
    faceRatio = autoCropFaceRatio,
    centeringMode = autoCropCenteringMode,
    preserveFullHead = autoCropPreserveFullHead
  ): void => {
    if (!imageSize) return
    const transform = getSmartAvatarCropTransform(
      imageSize.w,
      imageSize.h,
      candidate,
      AVATAR_VIEW_SIZE,
      faceRatio,
      centeringMode,
      preserveFullHead
    )
    setBaseScale(transform.baseScale)
    setZoom(transform.zoom)
    setOffset({ x: transform.offsetX, y: transform.offsetY })
    setActiveAutoCropCandidate(candidate.id)

    const constraintMessage =
      transform.constraint === 'source-too-tight'
        ? '原图留白不足，已使用可行的最小裁剪，可继续手动微调'
        : transform.constraint === 'source-edge'
          ? '人脸靠近图片边缘，已在不露出空白的范围内居中'
          : transform.constraint === 'zoom-limit'
            ? '原图中的人脸较小，已放大到上限，可继续手动微调'
            : null
    const headFallbackMessage = !candidate.headBounds
      ? preserveFullHead
        ? '未识别到完整头发轮廓，完整头部保护未生效，可继续手动微调'
        : centeringMode === 'head'
          ? '未识别到完整头发轮廓，已按脸部比例估算头部中心，可继续手动微调'
          : null
      : null
    const message = constraintMessage ?? headFallbackMessage
    toast.show(message ?? '已完成智能构图，可继续拖动微调', message ? 'info' : 'success')
  }

  const applySmartCrop = async (): Promise<void> => {
    const img = imgRef.current
    if (!img || !imageSize || smartCropping) return
    const seq = ++autoCropSeqRef.current
    setSmartCropping(true)
    try {
      const [bitmap, appSettings] = await Promise.all([
        createAvatarAnalysisBitmap(img),
        api.settings.get()
      ])
      const result = await analyzeAvatarBitmap(
        bitmap,
        appSettings.avatarCenteringMode,
        appSettings.avatarPreserveFullHead
      )
      if (seq !== autoCropSeqRef.current) return
      setAutoCropCandidates(result.candidates)
      setActiveAutoCropCandidate(null)
      setAutoCropFaceRatio(appSettings.avatarFaceRatio)
      setAutoCropCenteringMode(appSettings.avatarCenteringMode)
      setAutoCropPreserveFullHead(appSettings.avatarPreserveFullHead)
      if (result.ambiguous) {
        toast.show(`检测到 ${result.candidates.length} 张可能的人脸，请选择目标`, 'info')
        return
      }
      applyAutoCropCandidate(
        result.candidates[0],
        appSettings.avatarFaceRatio,
        appSettings.avatarCenteringMode,
        appSettings.avatarPreserveFullHead
      )
    } catch (error) {
      if (seq !== autoCropSeqRef.current) return
      setAutoCropCandidates([])
      setActiveAutoCropCandidate(null)
      toast.show(String((error as Error).message || '智能构图失败'), 'error')
    } finally {
      if (seq === autoCropSeqRef.current) setSmartCropping(false)
    }
  }

  const editing = Boolean(editUrl && metricsReady)
  const cropLayout =
    editing && imageSize
      ? getCropImageLayout(imageSize.w, imageSize.h, baseScale, zoom, offset.x, offset.y, AVATAR_VIEW_SIZE)
      : null
  const usesNativeCoverLayout =
    editing && isDefaultCropTransform(zoom, offset.x, offset.y)
  const previewCrop = useMemo(() => {
    if (editing || !sourceUrl || !savedCrop || !previewSourceSize) return null
    const defaults = getDefaultCropTransform(
      previewSourceSize.w,
      previewSourceSize.h,
      AVATAR_VIEW_SIZE
    )
    const scaled = scaleAvatarCropToViewSize(savedCrop, AVATAR_VIEW_SIZE)
    const clamped = clampCropOffset(
      scaled.offsetX,
      scaled.offsetY,
      previewSourceSize.w,
      previewSourceSize.h,
      defaults.baseScale,
      scaled.zoom,
      AVATAR_VIEW_SIZE
    )
    return {
      url: sourceUrl,
      zoom: scaled.zoom,
      offset: clamped,
      layout: getCropImageLayout(
        previewSourceSize.w,
        previewSourceSize.h,
        defaults.baseScale,
        scaled.zoom,
        clamped.x,
        clamped.y,
        AVATAR_VIEW_SIZE
      )
    }
  }, [editing, previewSourceSize, savedCrop, sourceUrl])
  const previewUsesNativeCoverLayout = previewCrop
    ? isDefaultCropTransform(previewCrop.zoom, previewCrop.offset.x, previewCrop.offset.y)
    : false

  const tabs: Array<{ id: SourceTab; label: string; disabled?: boolean }> = [
    { id: 'current', label: '当前', disabled: !editableSourceUrl },
    { id: 'local', label: '本地' },
    { id: 'cover', label: '封面', disabled: false },
    { id: 'gallery', label: '写真', disabled: false }
  ]

  const editingCurrent = editing && activeSourceKey === 'current'
  const openingCurrent = openingSourceKey === 'current'
  const currentSourceNote = openError
    ? openError
    : openingCurrent
      ? '正在打开头像…'
      : editingCurrent && legacyNoSource
        ? '当前头像无原图，缩放空间有限；重新选图后可保留原图'
        : editingCurrent
          ? '已还原当前裁剪，可在左侧继续调整'
          : '点击编辑裁剪后可调整头像'
  const pickerError = activeTab !== 'current' && openError ? openError : null

  return (
    <div className="actress-avatar-editor">
      <div className="avatar-editor-layout">
        <div className="avatar-editor-stage">
          <div
            ref={viewportRef}
            className={`avatar-crop-viewport${editing ? ' avatar-crop-viewport--active' : ''}`}
            style={{ width: AVATAR_VIEW_SIZE, height: AVATAR_VIEW_SIZE }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDragStart={(e) => e.preventDefault()}
          >
            {editing && cropLayout ? (
              usesNativeCoverLayout ? (
                <img
                  ref={imgRef}
                  crossOrigin="anonymous"
                  src={editUrl ?? undefined}
                  alt=""
                  className="avatar-crop-preview"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <img
                  ref={imgRef}
                  crossOrigin="anonymous"
                  src={editUrl ?? undefined}
                  alt=""
                  className="avatar-crop-image"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  style={{
                    left: `${cropLayout.left}px`,
                    top: `${cropLayout.top}px`,
                    width: `${cropLayout.width}px`,
                    height: `${cropLayout.height}px`
                  }}
                />
              )
            ) : previewCrop ? (
              previewUsesNativeCoverLayout ? (
                <img
                  src={previewCrop.url}
                  alt=""
                  className="avatar-crop-preview"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <img
                  src={previewCrop.url}
                  alt=""
                  className="avatar-crop-image"
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                  style={{
                    left: `${previewCrop.layout.left}px`,
                    top: `${previewCrop.layout.top}px`,
                    width: `${previewCrop.layout.width}px`,
                    height: `${previewCrop.layout.height}px`
                  }}
                />
              )
            ) : displayUrl ? (
              <img src={displayUrl} alt="" className="avatar-crop-preview" />
            ) : (
              <div className="avatar-crop-empty">无头像</div>
            )}
          </div>
        </div>

        <div className="avatar-editor-workspace">
          <div className="avatar-source-panel">
            <div className="avatar-source-tabs" role="tablist" aria-label="头像来源">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  className={activeTab === tab.id ? 'active' : ''}
                  disabled={tab.disabled}
                  onClick={() => {
                    setOpenError(null)
                    initialTabResolved.current = true
                    setActiveTab(tab.id)
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="avatar-source-panel-body">
              <div
                className={`avatar-source-page${activeTab === 'current' ? ' is-active' : ''}`}
                role="tabpanel"
                hidden={activeTab !== 'current'}
              >
                {editableSourceUrl ? (
                  <div className="avatar-source-static">
                    <p className="avatar-source-note">{currentSourceNote}</p>
                    <Button
                      type="button"

                      size="sm"
                      variant={editingCurrent ? 'primary' : 'default'}
                      disabled={editingCurrent || openingCurrent}
                      onClick={loadCurrentAvatar}
                    >
                      {openingCurrent ? '打开中' : editingCurrent ? '编辑中' : '编辑裁剪'}
                    </Button>
                  </div>
                ) : (
                  <p className="avatar-source-empty">暂无头像，请从其他来源选择</p>
                )}
              </div>

              <div
                className={`avatar-source-page${activeTab === 'local' ? ' is-active' : ''}`}
                role="tabpanel"
                hidden={activeTab !== 'local'}
              >
                <div className="avatar-source-static">
                  <Button
                    type="button"

                    size="sm"
                    variant={activeSourceKey === 'local' ? 'primary' : 'default'}
                    onClick={() => { initialTabResolved.current = true; fileRef.current?.click() }}
                  >
                    选择本地图片…
                  </Button>
                  <p className="avatar-source-note">JPG · PNG · WebP</p>
                </div>
              </div>

              <div
                ref={coverScroll.ref}
                className={`avatar-source-page avatar-source-page--scroll${
                  activeTab === 'cover' ? ' is-active' : ''
                }${coverScroll.isDragging ? ' avatar-source-page--dragging' : ''}`}
                role="tabpanel"
                hidden={activeTab !== 'cover'}
                onScroll={onCoverScroll}
                onPointerDownCapture={coverScroll.onPointerDownCapture}
                onPointerMove={coverScroll.onPointerMove}
                onPointerUp={coverScroll.onPointerUp}
                onPointerCancel={coverScroll.onPointerCancel}
              >
                {covers.loading && coverVideos.length === 0 ? <p className="avatar-source-empty">加载中…</p> : covers.error && coverVideos.length === 0 ? (
                  <div role="alert">{covers.error}<Button onClick={covers.reload}>重试</Button></div>
                ) : coverVideos.length === 0 ? (
                  <p className="avatar-source-empty">暂无关联封面</p>
                ) : (
                  <>
                    {coverVideos.map((video) => {
                      const url = assetUrl(video.cover_path)
                      if (!url || !video.cover_path) return null
                      const sourceKey = `cover:${video.id}`
                      return (
                        <button
                          key={video.id}
                          type="button"
                          className={`avatar-pick-tile${activeSourceKey === sourceKey ? ' active' : ''}`}
                          title={video.code}
                          aria-label={video.code}
                          aria-busy={openingSourceKey === sourceKey}
                          onClick={() => {
                            if (openingSourceKey || coverScroll.shouldSuppressClick()) return
                            setOpenError(null)
                            setActiveSourceKey(sourceKey)
                            void beginEditSource({
                              url,
                              sourceKey,
                              libraryAssetPath: video.cover_path
                            })
                          }}
                        >
                          <img src={assetUrl(video.cover_path, 320) ?? undefined} alt="" loading="lazy" draggable={false} />
                        </button>
                      )
                    })}
                    {covers.error ? (
                      <div role="alert">{covers.error}<Button onClick={covers.reload}>重试</Button></div>
                    ) : null}
                  </>
                )}
              </div>



              <div
                ref={galleryScroll.ref}
                className={`avatar-source-page avatar-source-page--scroll${
                  activeTab === 'gallery' ? ' is-active' : ''
                }${galleryScroll.isDragging ? ' avatar-source-page--dragging' : ''}`}
                role="tabpanel"
                hidden={activeTab !== 'gallery'}
                onPointerDownCapture={galleryScroll.onPointerDownCapture}
                onPointerMove={galleryScroll.onPointerMove}
                onPointerUp={galleryScroll.onPointerUp}
                onPointerCancel={galleryScroll.onPointerCancel}
              >
                {photos.loading ? <p className="avatar-source-empty">加载中…</p> : photos.error ? (
                  <div role="alert">{photos.error}<Button onClick={photos.reload}>重试</Button></div>
                ) : galleryItems.length === 0 ? (
                  <p className="avatar-source-empty">暂无写真</p>
                ) : (
                  galleryItems.map((asset, index) => {
                    const url = gallerySrc(asset)
                    if (!url || !asset.local_path) return null
                    const sourceKey = `gallery:${asset.id}`
                    const label = `写真 ${photos.offset + index + 1}`
                    return (
                      <button
                        key={asset.id}
                        type="button"
                        className={`avatar-pick-tile${activeSourceKey === sourceKey ? ' active' : ''}`}
                        title={label}
                        aria-label={label}
                        aria-busy={openingSourceKey === sourceKey}
                        onClick={() => {
                          if (openingSourceKey || galleryScroll.shouldSuppressClick()) return
                          setOpenError(null)
                          setActiveSourceKey(sourceKey)
                          void beginEditSource({
                            url,
                            sourceKey,
                            libraryAssetPath: asset.local_path
                          })
                        }}
                      >
                        <img src={assetUrl(asset.local_path, 320) ?? undefined} alt="" loading="lazy" draggable={false} />
                      </button>
                    )
                  })
                )}
              </div>
              {pickerError ? (
                <div className="avatar-source-picker-toast avatar-source-picker-toast--error" role="alert">
                  {pickerError}
                </div>
              ) : null}
            </div>

              {activeTab === 'gallery' && photos.data && photos.data.total > 60 ? (
                <nav className="actress-works-pagination" aria-label="头像写真分页">
                  <Button size="sm" disabled={photos.offset === 0} onClick={() => photos.move(photos.offset - 60)}>上一页</Button>
                  <span>第 {Math.floor(photos.offset / 60) + 1} 页</span>
                  <Button size="sm" disabled={photos.offset + galleryItems.length >= photos.data.total} onClick={() => photos.move(photos.offset + 60)}>下一页</Button>
                </nav>
              ) : null}
          </div>

          <div
            className={`avatar-editor-edit-bar${editing ? ' avatar-editor-edit-bar--visible' : ''}`}
            aria-hidden={!editing}
          >
            <div className="avatar-editor-edit-row">
              <label className="avatar-crop-zoom-label">
                缩放
                <input
                  type="range"
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  tabIndex={editing ? 0 : -1}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              {autoCropCandidates.length > 1 ? (
                <div className="avatar-face-candidates" role="group" aria-label="选择检测到的人脸">
                  <span className="avatar-face-candidates-label">人脸</span>
                  {autoCropCandidates.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className={`avatar-face-candidate${activeAutoCropCandidate === candidate.id ? ' active' : ''}`}
                      aria-pressed={activeAutoCropCandidate === candidate.id}
                      aria-label={`选择第 ${index + 1} 张人脸`}
                      title={`人脸 ${index + 1}`}
                      onClick={() => applyAutoCropCandidate(candidate)}
                    >
                      {index + 1}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="avatar-editor-actions">
                <Button
                  type="button"
                  variant="primary"

                  size="sm"
                  className="avatar-smart-crop-button"
                  tabIndex={editing ? 0 : -1}
                  disabled={!editing || smartCropping}
                  aria-busy={smartCropping || undefined}
                  onClick={() => void applySmartCrop()}
                >
                  {smartCropping ? <span className="avatar-smart-crop-spinner" aria-hidden /> : null}
                  <span>{smartCropping ? '构图中' : '智能构图'}</span>
                </Button>
                <Button
                  type="button"

                  size="sm"
                  tabIndex={editing ? 0 : -1}
                  onClick={resetTransform}
                >
                  重置
                </Button>
                <Button
                  type="button"

                  size="sm"
                  tabIndex={editing ? 0 : -1}
                  onClick={clearSource}
                >
                  取消
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif"
        hidden
        onChange={onFileChange}
      />
    </div>
  )
}
