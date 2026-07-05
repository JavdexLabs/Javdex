import { useCallback, useMemo, useState } from 'react'
import { useImagePreviewById } from '../hooks/useImagePreviewById'
import type { VideoAsset } from '@shared/types'
import { prepareVideoSamplesForDisplay, SAMPLE_FALLBACK_RATIO } from '@shared/mediaGalleryDisplay'
import { api, assetUrl } from '../api'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useElementSize } from '../hooks/useElementSize'
import ImagePreviewLightbox, { type ImagePreviewItem } from './ImagePreviewLightbox'
import ImageImportModal from './ImageImportModal'
import MediaTileDeleteButton from './MediaTileDeleteButton'
import Modal from './Modal'
import IconButton from './IconButton'
import { useToast } from './Toast'
import { ImagePlus } from 'lucide-react'
import { UI_ICON } from './iconDefaults'

const SAMPLE_MASONRY_GAP = 10
const SAMPLE_MASONRY_MIN_COL_WIDTH = 260

function sampleSrc(asset: VideoAsset): string | null {
  return assetUrl(asset.local_path) ?? asset.remote_url
}

function sampleRatio(asset: VideoAsset, measuredRatios?: Record<number, number>): number {
  const measuredRatio = measuredRatios?.[asset.id]
  if (measuredRatio && Number.isFinite(measuredRatio) && measuredRatio > 0) {
    return measuredRatio
  }
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
    return SAMPLE_FALLBACK_RATIO
  }
  const ratio = asset.width / asset.height
  return Number.isFinite(ratio) && ratio > 0 ? ratio : SAMPLE_FALLBACK_RATIO
}

const SAMPLE_PREVIEW_LABELS = {
  dialog: '样张预览',
  filmstrip: '样张缩略图',
  thumb: (index: number) => `样张 ${index + 1}`,
  posterMissing: '这张样张尚未保存到本地资产目录'
} as const

interface SampleMasonryColumn {
  height: number
  items: Array<{ asset: VideoAsset; index: number }>
}

function findShortestColumnIndex(columns: SampleMasonryColumn[]): number {
  let targetIndex = 0
  for (let i = 1; i < columns.length; i++) {
    if (columns[i].height < columns[targetIndex].height) targetIndex = i
  }
  return targetIndex
}

function createSampleMasonryColumns(
  samples: VideoAsset[],
  columnCount: number,
  columnWidth: number,
  measuredRatios: Record<number, number>
): SampleMasonryColumn[] {
  const columns = Array.from({ length: columnCount }, () => ({
    height: 0,
    items: [] as Array<{ asset: VideoAsset; index: number }>
  }))

  samples.forEach((asset, index) => {
    const targetIndex = index < columnCount ? index : findShortestColumnIndex(columns)
    columns[targetIndex].items.push({ asset, index })
    columns[targetIndex].height += columnWidth / sampleRatio(asset, measuredRatios) + SAMPLE_MASONRY_GAP
  })

  return columns
}

function toPreviewItems(samples: VideoAsset[]): ImagePreviewItem[] {
  return samples.flatMap((asset) => {
    const src = sampleSrc(asset)
    if (!src) return []
    return [{ id: asset.id, src, localPath: asset.local_path }]
  })
}

export default function VideoSampleGallery({
  videoId,
  assets,
  posterPath,
  onChanged
}: {
  videoId: number
  assets: VideoAsset[]
  posterPath: string | null
  onChanged: () => void
}): JSX.Element {
  const toast = useToast()
  const { ref: masonryRef, width: masonryWidth } = useElementSize<HTMLDivElement>()
  const samples = useMemo(() => prepareVideoSamplesForDisplay(assets), [assets])
  const previewItems = useMemo(() => toPreviewItems(samples), [samples])
  const { previewIndex, isOpen, openPreview, closePreview, closePreviewIf, setPreviewIndex } =
    useImagePreviewById(previewItems)

  const dismissOverlays = useCallback(() => {
    setShowImport(false)
    setDeleteTarget(null)
    closePreview()
  }, [closePreview])

  useDismissOverlaysOnNavigate(dismissOverlays, videoId)

  const [measuredRatios, setMeasuredRatios] = useState<Record<number, number>>({})
  const [showImport, setShowImport] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<VideoAsset | null>(null)
  const [deleting, setDeleting] = useState(false)

  const changePoster = useCallback(
    async (nextPosterPath: string | null) => {
      try {
        await api.videos.setPoster(videoId, nextPosterPath)
        toast.show(nextPosterPath ? '已设为背景' : '已清除背景', 'success')
        onChanged()
      } catch (e) {
        toast.show(String((e as Error).message), 'error')
      }
    },
    [onChanged, toast, videoId]
  )

  const updateMeasuredRatio = useCallback((assetId: number, img: HTMLImageElement) => {
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return

    const ratio = img.naturalWidth / img.naturalHeight
    if (!Number.isFinite(ratio) || ratio <= 0) return

    setMeasuredRatios((current) => {
      if (Math.abs((current[assetId] ?? 0) - ratio) < 0.0001) return current
      return { ...current, [assetId]: ratio }
    })
  }, [])

  const masonryColumns = useMemo(() => {
    const columnCount =
      masonryWidth > 0
        ? Math.max(
            1,
            Math.floor(
              (masonryWidth + SAMPLE_MASONRY_GAP) /
                (SAMPLE_MASONRY_MIN_COL_WIDTH + SAMPLE_MASONRY_GAP)
            )
          )
        : 1
    const columnWidth =
      masonryWidth > 0
        ? (masonryWidth - SAMPLE_MASONRY_GAP * Math.max(0, columnCount - 1)) / columnCount
        : SAMPLE_MASONRY_MIN_COL_WIDTH
    return createSampleMasonryColumns(samples, columnCount, columnWidth, measuredRatios)
  }, [masonryWidth, measuredRatios, samples])

  const deleteSample = async (): Promise<void> => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await api.videos.deleteSample(videoId, deleteTarget.id)
      setDeleteTarget(null)
      closePreviewIf(deleteTarget.id)
      toast.show('样张已删除', 'success')
      onChanged()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <section className="detail-section detail-section--samples">
        <div className="detail-section-head sample-section-head">
          <h2 className="section-title">样张</h2>
          <div className="detail-section-actions">
            <span className="detail-section-count">{samples.length} 张</span>
            <IconButton
              className="detail-icon-action"
              icon={<ImagePlus {...UI_ICON} />}
              label="导入样张"
              onClick={() => setShowImport(true)}
            />
          </div>
        </div>
        {samples.length === 0 ? (
          <div className="sample-empty">暂无样张</div>
        ) : (
          <div className="sample-masonry" ref={masonryRef}>
            {masonryColumns.map((column, columnIndex) => (
              <div key={columnIndex} className="sample-masonry-column">
                {column.items.map(({ asset, index }) => {
                  const src = sampleSrc(asset)
                  if (!src) return null
                  return (
                    <div key={asset.id} className="sample-masonry-item">
                      <button
                        type="button"
                        className="sample-masonry-btn"
                        onClick={() => openPreview(asset.id)}
                        aria-label={`样张 ${index + 1}`}
                      >
                        <img
                          src={src}
                          alt=""
                          loading="lazy"
                          draggable={false}
                          onLoad={(e) => updateMeasuredRatio(asset.id, e.currentTarget)}
                        />
                      </button>
                      <MediaTileDeleteButton
                        label={`删除样张 ${index + 1}`}
                        title="删除样张"
                        onClick={() => setDeleteTarget(asset)}
                      />
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>
      {isOpen && previewIndex != null && (
        <ImagePreviewLightbox
          items={previewItems}
          index={previewIndex}
          labels={SAMPLE_PREVIEW_LABELS}
          posterPath={posterPath}
          onClose={closePreview}
          onIndexChange={setPreviewIndex}
          onPosterChange={changePoster}
        />
      )}
      {showImport && (
        <ImageImportModal
          title="导入样张"
          itemLabel="样张"
          emptyText="暂无待导入样张，拖入图片或选择本地文件开始导入。"
          urlHint="每次输入一个图片链接，加载成功后会加入待导入列表。"
          onCancel={() => setShowImport(false)}
          onChanged={onChanged}
          onImportFilePath={(sourcePath) =>
            api.videos.importSample(videoId, { source: 'file', sourcePath })
          }
          onImportUrl={(remoteUrl) => api.videos.importSample(videoId, { source: 'url', remoteUrl })}
        />
      )}
      {deleteTarget && (
        <Modal
          title="删除样张"
          danger
          confirmText={deleting ? '删除中...' : '删除'}
          onConfirm={() => void deleteSample()}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          确定删除这张样张？本地导入的样张文件也会一并删除。
        </Modal>
      )}
    </>
  )
}
