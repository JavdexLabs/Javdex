import type { ImageThumbnailSize } from '@shared/imageVariants'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActressGalleryPage } from '../hooks/useActressGalleryPage'
import { useActressGalleryPreview } from '../hooks/useActressGalleryPreview'
import Button from './Button'
import type { ActressGalleryAsset } from '@shared/actressTypes'
import {
  actressGalleryRatio
} from '@shared/mediaGalleryDisplay'
import { api, assetUrl } from '../api'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useElementSize } from '../hooks/useElementSize'
import ImagePreviewLightbox, { type ImagePreviewItem } from './ImagePreviewLightbox'
import ImageImportModal from './ImageImportModal'
import MediaTileActionButton from './MediaTileActionButton'
import Modal from './Modal'
import IconButton from './IconButton'
import EmptyState from './EmptyState'
import { useToast } from './Toast'
import { ImagePlus } from 'lucide-react'
import { UI_ICON } from './iconDefaults'

const GALLERY_MASONRY_GAP = 10
const GALLERY_MASONRY_MIN_COL_WIDTH = 260

function gallerySrc(asset: ActressGalleryAsset, size?: ImageThumbnailSize): string | null {
  return assetUrl(asset.local_path, size) ?? asset.remote_url
}

function galleryRatio(asset: ActressGalleryAsset): number {
  return actressGalleryRatio(asset)
}

interface GalleryMasonryLayoutItem {
  asset: ActressGalleryAsset
  index: number
  x: number
  y: number
  width: number
  height: number
}

interface GalleryMasonryLayout {
  items: GalleryMasonryLayoutItem[]
  height: number
}

function galleryColumnSpan(asset: ActressGalleryAsset, columnCount: number): number {
  const ratio = galleryRatio(asset)
  return ratio > 1 && columnCount > 1 ? 2 : 1
}

function findShortestSpanStart(columnHeights: number[], span: number): number {
  let targetIndex = 0
  let targetHeight = Number.POSITIVE_INFINITY

  for (let start = 0; start <= columnHeights.length - span; start++) {
    const height = Math.max(...columnHeights.slice(start, start + span))
    if (height < targetHeight) {
      targetHeight = height
      targetIndex = start
    }
  }

  return targetIndex
}

function createGalleryMasonryLayout(
  items: ActressGalleryAsset[],
  columnCount: number,
  columnWidth: number
): GalleryMasonryLayout {
  const columnHeights = Array.from({ length: columnCount }, () => 0)
  const layoutItems: GalleryMasonryLayoutItem[] = []

  items.forEach((asset, index) => {
    const span = galleryColumnSpan(asset, columnCount)
    const start = findShortestSpanStart(columnHeights, span)
    const y = Math.max(...columnHeights.slice(start, start + span))
    const x = start * (columnWidth + GALLERY_MASONRY_GAP)
    const width = columnWidth * span + GALLERY_MASONRY_GAP * (span - 1)
    const height = width / galleryRatio(asset)

    layoutItems.push({ asset, index, x, y, width, height })

    const nextHeight = y + height + GALLERY_MASONRY_GAP
    for (let i = start; i < start + span; i++) {
      columnHeights[i] = nextHeight
    }
  })

  return {
    items: layoutItems,
    height: Math.max(0, Math.max(0, ...columnHeights) - GALLERY_MASONRY_GAP)
  }
}

const GALLERY_PREVIEW_LABELS = {
  dialog: '写真预览',
  filmstrip: '写真缩略图',
  thumb: (index: number) => `写真 ${index + 1}`,
  posterMissing: '这张写真尚未保存到本地资产目录'
} as const

function toPreviewItems(items: ActressGalleryAsset[]): ImagePreviewItem[] {
  return items.flatMap((asset) => {
    const src = gallerySrc(asset)
    if (!src) return []
    return [{ id: asset.id, src, thumbnailSrc: gallerySrc(asset, 320) ?? src, localPath: asset.local_path }]
  })
}

export default function ActressGalleryPanel({
  actressId,
  revision,
  posterPath,
  onChanged
}: {
  actressId: number
  revision: object
  posterPath: string | null
  onChanged: () => void
}): JSX.Element {
  const toast = useToast()
  const { ref: masonryRef, width: masonryWidth } = useElementSize<HTMLDivElement>()
  const [showImport, setShowImport] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ActressGalleryAsset | null>(null)
  const [deleting, setDeleting] = useState(false)

  const changePoster = useCallback(
    async (nextPosterPath: string | null) => {
      try {
        await api.actresses.setPoster(actressId, nextPosterPath)
        toast.show(nextPosterPath ? '已设为背景' : '已清除背景', 'success')
        onChanged()
      } catch (e) {
        toast.show(String((e as Error).message), 'error')
      }
    },
    [actressId, onChanged, toast]
  )

  const photos = useActressGalleryPage(actressId)
  const preview = useActressGalleryPreview(actressId)
  const reloadPhotos = photos.reload
  const items = useMemo(() => photos.data?.items ?? [], [photos.data])
  const previewItems = useMemo(() => toPreviewItems(preview.view?.page.items ?? []), [preview.view])
  const refreshPreview = useRef(preview.refresh)
  refreshPreview.current = preview.refresh
  const previousRevision = useRef(revision)
  useEffect(() => {
    if (previousRevision.current === revision) return
    previousRevision.current = revision
    reloadPhotos()
    refreshPreview.current()
  }, [revision, reloadPhotos])
  const closePreview = preview.close

  const dismissOverlays = useCallback(() => {
    setShowImport(false)
    setDeleteTarget(null)
    closePreview()
  }, [closePreview])

  useDismissOverlaysOnNavigate(dismissOverlays, actressId)

  const masonryLayout = useMemo(() => {
    const columnCount =
      masonryWidth > 0
        ? Math.max(
            1,
            Math.floor(
              (masonryWidth + GALLERY_MASONRY_GAP) /
                (GALLERY_MASONRY_MIN_COL_WIDTH + GALLERY_MASONRY_GAP)
            )
          )
        : 1
    const columnWidth =
      masonryWidth > 0
        ? (masonryWidth - GALLERY_MASONRY_GAP * Math.max(0, columnCount - 1)) / columnCount
        : GALLERY_MASONRY_MIN_COL_WIDTH
    return createGalleryMasonryLayout(items, columnCount, columnWidth)
  }, [items, masonryWidth])

  const deleteImage = async (): Promise<void> => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await api.actresses.deleteGalleryImage(actressId, deleteTarget.id)
      setDeleteTarget(null)
      preview.closeIf(deleteTarget.id)
      toast.show('写真已删除', 'success')
      onChanged()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div className="actress-gallery-toolbar">
        <div className="actress-gallery-count">{photos.data ? `${photos.data.total} 张写真` : '写真读取中…'}</div>
        <IconButton
          className="detail-icon-action"
          icon={<ImagePlus {...UI_ICON} />}
          label="导入写真"
          onClick={() => setShowImport(true)}
        />
      </div>

      {photos.loading ? <p role="status">正在加载写真…</p> : photos.error ? (
        <div role="alert">{photos.error}<Button onClick={photos.reload}>重试</Button></div>
      ) : items.length === 0 ? (
        <EmptyState
          variant="compact"
          className="sample-empty"
          icon={<ImagePlus {...UI_ICON} aria-hidden />}
          title="暂无写真"
          description="导入图片后会在这里展示。"
        />
      ) : (
        <div
          className="actress-gallery-masonry"
          ref={masonryRef}
          style={{ height: masonryLayout.height }}
        >
          {masonryLayout.items.map(({ asset, index, x, y, width, height }) => {
            const src = gallerySrc(asset, 640)
            if (!src) return null
            return (
              <div
                key={asset.id}
                className="sample-masonry-item actress-gallery-masonry-item"
                style={{
                  width,
                  height,
                  transform: `translate3d(${x}px, ${y}px, 0)`
                }}
              >
                <button
                  type="button"
                  className="sample-masonry-btn actress-gallery-masonry-btn"
                  disabled={!preview.enabled}
                  onClick={() => { if (photos.data) preview.open(photos.data, asset.id) }}
                  aria-label={`写真 ${photos.offset + index + 1}`}
                >
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    draggable={false}
                  />
                </button>
                <MediaTileActionButton
                  label={`删除写真 ${photos.offset + index + 1}`}
                  title="删除写真"
                  onClick={() => setDeleteTarget(asset)}
                />
              </div>
            )
          })}
        </div>
      )}

      {photos.data && photos.data.total > 60 && (
        <nav className="actress-works-pagination" aria-label="演员写真分页">
          <Button disabled={photos.offset === 0} onClick={() => photos.move(photos.offset - 60)}>上一页</Button>
          <span>第 {Math.floor(photos.offset / 60) + 1} 页 · 共 {photos.data.total} 张</span>
          <Button disabled={photos.offset + items.length >= photos.data.total} onClick={() => photos.move(photos.offset + 60)}>下一页</Button>
        </nav>
      )}

      {preview.view && (
        <ImagePreviewLightbox
          items={previewItems}
          index={preview.view.index}
          windowOffset={preview.view.page.offset}
          total={preview.view.page.total}
          loading={preview.loading}
          navigationStatus={preview.error ? <span role="alert">写真加载失败<Button onClick={preview.retry}>重试</Button></span> : preview.loading ? <span role="status">正在加载写真…</span> : undefined}
          labels={GALLERY_PREVIEW_LABELS}
          posterPath={posterPath}
          onClose={closePreview}
          onIndexChange={preview.select}
          onPosterChange={changePoster}
        />
      )}

      {showImport && (
        <ImageImportModal
          title="导入写真"
          itemLabel="写真"
          emptyText="暂无待导入写真，拖入图片或选择本地文件开始导入。"
          urlHint="每次输入一个图片链接，加载成功后会加入待导入列表。"
          onCancel={() => setShowImport(false)}
          onChanged={onChanged}
          onImportFilePath={(sourcePath) =>
            api.actresses.importGalleryImage(actressId, { source: 'file', sourcePath })
          }
          onImportUrl={(remoteUrl) =>
            api.actresses.importGalleryImage(actressId, { source: 'url', remoteUrl })
          }
        />
      )}

      {deleteTarget && (
        <Modal
          title="删除写真"
          danger
          confirmText={deleting ? '删除中...' : '删除'}
          onConfirm={() => void deleteImage()}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          确定删除这张写真？本地文件也会一并删除。
        </Modal>
      )}
    </>
  )
}
