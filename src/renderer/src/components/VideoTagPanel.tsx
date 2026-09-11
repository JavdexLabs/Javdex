import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VideoTag } from '@shared/videoTypes'
import { api } from '../api'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useDebounce } from '../hooks/useDebounce'
import { useManualTagOptions } from '../hooks/useManualTagOptions'
import Modal from './Modal'
import { AppFormField } from './FormPrimitives'
import { useToast } from './Toast'
import { Plus, SearchX, Tags, X } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON, UI_ICON_SM } from './iconDefaults'
import EmptyState from './EmptyState'
import Button from './Button'

interface Props {
  videoId: number
  tags: VideoTag[]
  onFilterTag: (tag: VideoTag) => void
  onChanged: () => void
}

export default function VideoTagPanel({
  videoId,
  tags,
  onFilterTag,
  onChanged
}: Props): JSX.Element {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [addForVideoId, setAddForVideoId] = useState<number | null>(null)
  const addOpen = addForVideoId === videoId
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeSelection, setRemoveSelection] = useState<{ videoId: number; tag: VideoTag } | null>(null)
  const removeTarget = removeSelection?.videoId === videoId ? removeSelection.tag : null
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const context = useRef(0)
  useEffect(() => {
    const generation = context.current + 1
    context.current = generation
    return () => { context.current = generation + 1 }
  }, [videoId])
  const search = draft.trim()
  const debouncedSearch = useDebounce(search, 250)
  const searchPending = search !== debouncedSearch
  const options = useManualTagOptions(addOpen && !searchPending, videoId, debouncedSearch, offset, retry)
  const catalogLoading = searchPending || options.loading
  const catalogScrollRef = useRef<HTMLDivElement>(null)
  const onCatalogRange = options.window.onVisibleRange
  const catalogItems = options.items
  const catalogHasMore = options.hasMore
  const onCatalogScroll = (event: { currentTarget: { scrollTop: number; clientHeight: number; scrollHeight: number } }): void => {
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
    const overflow = scrollHeight > clientHeight + 8
    if (scrollTop <= 24) onCatalogRange(0, 20)
    if (overflow && scrollTop + clientHeight >= scrollHeight - 32) {
      onCatalogRange(Math.max(catalogItems.length, 1) - 1, catalogItems.length + 99)
    }
  }
  useLayoutEffect(() => {
    const cloud = catalogScrollRef.current
    if (!cloud || catalogLoading || options.error || !catalogHasMore || catalogItems.length === 0 || catalogItems.length >= 300) return
    if (cloud.scrollHeight <= cloud.clientHeight + 8) {
      onCatalogRange(Math.max(catalogItems.length, 1) - 1, catalogItems.length + 99)
    }
  }, [catalogItems.length, catalogHasMore, catalogLoading, options.error, onCatalogRange])

  const dismissOverlays = useCallback(() => {
    setAddForVideoId(null)
    setDraft('')
    setRemoveSelection(null)
    setOffset(0)
    setBusy(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, videoId)

  const scrapedTags = useMemo(() => tags.filter((tag) => tag.origin === 'scraped'), [tags])
  const manualTags = useMemo(() => tags.filter((tag) => tag.origin === 'manual'), [tags])
  const manualIdsOnVideo = useMemo(() => new Set(manualTags.map((tag) => tag.id)), [manualTags])

  const closeAddModal = useCallback((): void => {
    if (busy) return
    setAddForVideoId(null)
    setDraft('')
    setOffset(0)
  }, [busy])

  useEffect(() => {
    if (!addOpen) return
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [addOpen])

  const addTag = async (input: { name: string } | { tagId: number }): Promise<boolean> => {
    if (busy || ('name' in input && !input.name.trim())) return false
    const operationContext = context.current
    setBusy(true)
    try {
      if ('tagId' in input) await api.videos.addExistingManualTag(videoId, input.tagId)
      else await api.videos.addManualTag(videoId, input.name.trim())
      if (context.current !== operationContext) return true
      setAddForVideoId(null)
      setDraft('')
      setOffset(0)
      onChanged()
      return true
    } catch (e) {
      if (context.current === operationContext) {
        toast.show(String((e as Error).message ?? e), 'error')
        if ('tagId' in input) setRetry(value => value + 1)
      }
      return false
    } finally {
      if (context.current === operationContext) setBusy(false)
    }
  }

  const removeTag = async (tag: VideoTag): Promise<void> => {
    if (busy) return
    const operationContext = context.current
    setBusy(true)
    try {
      await api.videos.removeManualTag(videoId, tag.id)
      if (context.current !== operationContext) return
      setRemoveSelection(null)
      onChanged()
      toast.show(`已移除自定义标签「${tag.name}」`, 'success')
    } catch (e) {
      if (context.current === operationContext) toast.show(String((e as Error).message ?? e), 'error')
    } finally {
      if (context.current === operationContext) setBusy(false)
    }
  }

  return (
    <section className="detail-section video-tag-panel" aria-label="影片标签">
      <div className="detail-section-head">
        <h2 className="section-title">标签</h2>
        <span className="detail-section-count">{tags.length} 个</span>
      </div>
      <div className="tag-list">
        {scrapedTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            className="tag-chip tag-chip--scraped clickable"
            onClick={() => onFilterTag(tag)}
            title={`筛选刮削标签：${tag.name}`}
          >
            {tag.name}
          </button>
        ))}
        {manualTags.map((tag) => (
          <span key={tag.id} className="tag-chip tag-chip--custom">
            <button
              type="button"
              className="tag-chip-label"
              onClick={() => onFilterTag(tag)}
              title={`筛选自定义标签：${tag.name}`}
            >
              {tag.name}
            </button>
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`移除自定义标签 ${tag.name}`}
              disabled={busy}
              onClick={() => setRemoveSelection({ videoId, tag })}
            >
              <X {...UI_ICON_SM} />
            </button>
          </span>
        ))}
        <IconButton
          className="video-tag-add-btn"
          icon={<Plus {...UI_ICON} />}
          label="添加自定义标签"
          title="添加自定义标签"
          disabled={busy}
          onClick={() => setAddForVideoId(videoId)}
        />
      </div>

      {addOpen && (
        <Modal
          title="添加自定义标签"
          hint="输入新名称创建，或从下方选择已有标签快速添加。"
          size="md"
          className="modal--video-tag-add"
          confirmText={busy ? '添加中…' : '添加'}
          confirmDisabled={busy || !draft.trim()}
          onCancel={closeAddModal}
          onConfirm={() => void addTag({ name: draft })}
        >
          <div className="video-tag-add-modal-body">
            <div className="video-tag-add-modal-field">
              <AppFormField label="标签名称">
                <input
                  ref={inputRef}
                  id={`video-tag-add-input-${videoId}`}
                  className="text-input video-tag-add-modal-input"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value); setOffset(0) }}
                  maxLength={500}
                  placeholder="输入自定义标签名称"
                  disabled={busy}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void addTag({ name: draft })
                    }
                  }}
                />
              </AppFormField>
            </div>

            <section className="video-tag-add-modal-catalog" aria-label="已有自定义标签">
              <div className="video-tag-add-modal-catalog-head">
                <span className="app-form-section-title">已有自定义标签</span>
                <span className="video-tag-add-modal-catalog-count" aria-live="polite">
                  {catalogLoading ? '加载中…' : '按名称'}
                </span>
              </div>
              <div ref={catalogScrollRef} className="video-tag-add-modal-catalog-scroll" onScroll={onCatalogScroll}>
                {catalogLoading ? (
                  <EmptyState variant="modal" loading title="正在加载标签…" />
                ) : options.error && options.window.total === 0 ? (
                  <EmptyState variant="modal" title="标签加载失败" description={options.error}>
                    <Button size="sm" onClick={() => setRetry(value => value + 1)}>重试</Button>
                  </EmptyState>
                ) : options.items.length === 0 && !draft.trim() ? (
                  <EmptyState
                    variant="modal"
                    className="video-tag-add-modal-empty"
                    icon={<Tags {...UI_ICON_SM} aria-hidden />}
                    title={'\u6682\u65e0\u5df2\u6709\u6807\u7b7e'}
                    description={'\u53ef\u5728\u4e0a\u65b9\u8f93\u5165\u65b0\u540d\u79f0\u521b\u5efa\u6807\u7b7e\u3002'}
                  />
                ) : options.items.length === 0 ? (
                  <EmptyState
                    variant="modal"
                    className="video-tag-add-modal-empty"
                    icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                    title={'\u6ca1\u6709\u5339\u914d\u7684\u6807\u7b7e'}
                    description={'\u8c03\u6574\u5173\u952e\u8bcd\uff0c\u6216\u5728\u4e0a\u65b9\u76f4\u63a5\u521b\u5efa\u65b0\u6807\u7b7e\u3002'}
                  />
                ) : (
                  <>
                    <div className="video-tag-add-modal-catalog-list">
                      {options.items.map((tag) => {
                        const onVideo = manualIdsOnVideo.has(tag.id)
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            className={`tag-chip tag-chip--custom-pick${onVideo ? ' is-on-video' : ''}`}
                            disabled={busy || onVideo}
                            onClick={() => void addTag({ tagId: tag.id })}
                            title={
                              onVideo ? `已添加：${tag.label}` : `添加自定义标签：${tag.label}`
                            }
                            aria-pressed={onVideo}
                          >
                            {tag.label}
                          </button>
                        )
                      })}
                    </div>
                    {options.error ? (
                      <div role="alert">{options.error}<Button size="sm" onClick={options.reload}>重试</Button></div>
                    ) : null}
                  </>
                )}
              </div>

            </section>
          </div>
        </Modal>
      )}

      {removeTarget && (
        <Modal
          title="移除自定义标签"
          danger
          confirmText={busy ? '移除中…' : '移除'}
          confirmDisabled={busy}
          onConfirm={() => void removeTag(removeTarget)}
          onCancel={() => {
            if (!busy) setRemoveSelection(null)
          }}
        >
          确定从本片移除自定义标签「{removeTarget.name}」？
        </Modal>
      )}
    </section>
  )
}
