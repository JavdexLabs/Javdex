import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActressGalleryAsset, Video } from '@shared/types'
import { prepareActressGalleryForDisplay } from '@shared/mediaGalleryDisplay'
import { assetUrl } from '../api'
import { useHorizontalDragScroll } from '../hooks/useHorizontalDragScroll'
import {
  AVATAR_VIEW_SIZE,
  clampCropOffset,
  exportAvatarCrop,
  getCropImageLayout,
  getDefaultCropTransform
} from '../utils/avatarCrop'

type SourceTab = 'current' | 'local' | 'cover' | 'gallery'

interface Props {
  currentUrl: string | null
  videos: Video[]
  gallery: ActressGalleryAsset[]
  onAvatarChange: (base64: string | null) => void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
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

/** Circular preview, square export; pick from current avatar, local file, covers, or gallery. */
export default function ActressAvatarEditor({
  currentUrl,
  videos,
  gallery,
  onAvatarChange
}: Props): JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const loadSeqRef = useRef(0)
  const coverScroll = useHorizontalDragScroll()
  const galleryScroll = useHorizontalDragScroll()

  const coverVideos = useMemo(() => videos.filter((v) => v.cover_path), [videos])
  const galleryItems = useMemo(() => prepareActressGalleryForDisplay(gallery), [gallery])

  const defaultTab = useMemo((): SourceTab => {
    if (currentUrl) return 'current'
    if (coverVideos.length > 0) return 'cover'
    if (galleryItems.length > 0) return 'gallery'
    return 'local'
  }, [coverVideos.length, currentUrl, galleryItems.length])

  const [activeTab, setActiveTab] = useState<SourceTab>(defaultTab)
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [activeSourceKey, setActiveSourceKey] = useState<string | null>(null)
  const [baseScale, setBaseScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [metricsReady, setMetricsReady] = useState(false)
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | null>(null)

  const applyImageMetrics = useCallback((width: number, height: number) => {
    if (width <= 0 || height <= 0) return
    const next = getDefaultCropTransform(width, height, AVATAR_VIEW_SIZE)
    setImageSize({ w: width, h: height })
    setBaseScale(next.baseScale)
    setZoom(next.zoom)
    setOffset({ x: next.offsetX, y: next.offsetY })
    setMetricsReady(true)
  }, [])

  const resetTransform = useCallback((): void => {
    const img = imgRef.current
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      applyImageMetrics(img.naturalWidth, img.naturalHeight)
      return
    }
    setOffset({ x: 0, y: 0 })
    setZoom(1)
  }, [applyImageMetrics])

  const beginEditSource = useCallback(
    (url: string, sourceKey: string) => {
      if (sourceUrl === url && activeSourceKey === sourceKey && metricsReady) {
        const img = imgRef.current
        if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
          applyImageMetrics(img.naturalWidth, img.naturalHeight)
        }
        return
      }

      const seq = ++loadSeqRef.current

      void probeImage(url)
        .then(({ width, height }) => {
          if (seq !== loadSeqRef.current) return
          const next = getDefaultCropTransform(width, height, AVATAR_VIEW_SIZE)
          setSourceUrl((prev) => {
            if (prev?.startsWith('blob:') && prev !== url) URL.revokeObjectURL(prev)
            return url
          })
          setActiveSourceKey(sourceKey)
          setImageSize({ w: width, h: height })
          setBaseScale(next.baseScale)
          setZoom(next.zoom)
          setOffset({ x: next.offsetX, y: next.offsetY })
          setMetricsReady(true)
        })
        .catch(() => {
          if (seq !== loadSeqRef.current) return
        })
    },
    [activeSourceKey, applyImageMetrics, metricsReady, sourceUrl]
  )

  const clearSource = useCallback((): void => {
    loadSeqRef.current += 1
    setSourceUrl((prev) => {
      if (prev?.startsWith('blob:')) URL.revokeObjectURL(prev)
      return null
    })
    setActiveSourceKey(null)
    setMetricsReady(false)
    setImageSize(null)
    setBaseScale(1)
    setOffset({ x: 0, y: 0 })
    setZoom(1)
    onAvatarChange(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [onAvatarChange])

  const loadCurrentAvatar = useCallback((): void => {
    if (!currentUrl) return
    beginEditSource(currentUrl, 'current')
  }, [beginEditSource, currentUrl])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    beginEditSource(URL.createObjectURL(file), 'local')
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
    if (!sourceUrl || !metricsReady || !img?.naturalWidth) return
    const base64 = exportAvatarCrop(img, offset.x, offset.y, zoom, baseScale)
    onAvatarChange(base64 || null)
  }, [sourceUrl, offset, zoom, baseScale, metricsReady, onAvatarChange])

  useEffect(() => {
    if (!metricsReady) return
    setOffset((prev) => clampOffset(prev.x, prev.y))
  }, [zoom, baseScale, metricsReady, clampOffset])

  useEffect(() => {
    const node = viewportRef.current
    if (!node || !sourceUrl || !metricsReady) return

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
  }, [sourceUrl, metricsReady])

  useEffect(() => {
    return () => {
      if (sourceUrl?.startsWith('blob:')) URL.revokeObjectURL(sourceUrl)
    }
  }, [sourceUrl])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!sourceUrl || !metricsReady) return
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

  const editing = Boolean(sourceUrl && metricsReady)
  const cropLayout =
    editing && imageSize
      ? getCropImageLayout(imageSize.w, imageSize.h, baseScale, zoom, offset.x, offset.y, AVATAR_VIEW_SIZE)
      : null

  const tabs: Array<{ id: SourceTab; label: string; disabled?: boolean }> = [
    { id: 'current', label: '当前', disabled: !currentUrl },
    { id: 'local', label: '本地' },
    { id: 'cover', label: '封面', disabled: coverVideos.length === 0 },
    { id: 'gallery', label: '写真', disabled: galleryItems.length === 0 }
  ]

  const editingCurrent = editing && activeSourceKey === 'current'

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
              <img
                ref={imgRef}
                src={sourceUrl ?? undefined}
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
            ) : currentUrl ? (
              <img src={currentUrl} alt="" className="avatar-crop-preview" />
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
                onClick={() => setActiveTab(tab.id)}
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
              {currentUrl ? (
                <div className="avatar-source-static">
                  <p className="avatar-source-note">在左侧预览中调整裁剪</p>
                  <button
                    type="button"
                    className={`btn btn-sm${editingCurrent ? ' btn-primary' : ''}`}
                    disabled={editingCurrent}
                    onClick={loadCurrentAvatar}
                  >
                    {editingCurrent ? '编辑中' : '编辑裁剪'}
                  </button>
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
                <button
                  type="button"
                  className={`btn btn-sm${activeSourceKey === 'local' ? ' btn-primary' : ''}`}
                  onClick={() => fileRef.current?.click()}
                >
                  选择本地图片…
                </button>
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
              onPointerDownCapture={coverScroll.onPointerDownCapture}
              onPointerMove={coverScroll.onPointerMove}
              onPointerUp={coverScroll.onPointerUp}
              onPointerCancel={coverScroll.onPointerCancel}
            >
              {coverVideos.map((v) => {
                const url = assetUrl(v.cover_path)
                if (!url) return null
                const sourceKey = `cover:${v.id}`
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={`avatar-pick-tile${activeSourceKey === sourceKey ? ' active' : ''}`}
                    title={v.code}
                    aria-label={v.code}
                    onClick={() => {
                      if (coverScroll.shouldSuppressClick()) return
                      beginEditSource(url, sourceKey)
                    }}
                  >
                    <img src={url} alt="" loading="lazy" draggable={false} />
                  </button>
                )
              })}
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
              {galleryItems.map((asset, index) => {
                const url = gallerySrc(asset)
                if (!url) return null
                const sourceKey = `gallery:${asset.id}`
                const label = `写真 ${index + 1}`
                return (
                  <button
                    key={asset.id}
                    type="button"
                    className={`avatar-pick-tile${activeSourceKey === sourceKey ? ' active' : ''}`}
                    title={label}
                    aria-label={label}
                    onClick={() => {
                      if (galleryScroll.shouldSuppressClick()) return
                      beginEditSource(url, sourceKey)
                    }}
                  >
                    <img src={url} alt="" loading="lazy" draggable={false} />
                  </button>
                )
              })}
            </div>
          </div>
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
              <div className="avatar-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  tabIndex={editing ? 0 : -1}
                  onClick={resetTransform}
                >
                  重置
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  tabIndex={editing ? 0 : -1}
                  onClick={clearSource}
                >
                  取消
                </button>
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
