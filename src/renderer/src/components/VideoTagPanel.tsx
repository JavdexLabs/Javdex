import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Tag, VideoTag } from '@shared/types'
import { api } from '../api'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import Modal from './Modal'
import { useToast } from './Toast'
import { Plus, SearchX, Tags, X } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON, UI_ICON_SM } from './iconDefaults'
import EmptyState from './EmptyState'

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
  const [addOpen, setAddOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<VideoTag | null>(null)
  const [manualCatalog, setManualCatalog] = useState<Tag[]>([])

  const dismissOverlays = useCallback(() => {
    setAddOpen(false)
    setDraft('')
    setRemoveTarget(null)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, videoId)

  const scrapedTags = useMemo(() => tags.filter((tag) => tag.origin === 'scraped'), [tags])
  const manualTags = useMemo(() => tags.filter((tag) => tag.origin === 'manual'), [tags])
  const manualIdsOnVideo = useMemo(() => new Set(manualTags.map((tag) => tag.id)), [manualTags])

  const refreshManualCatalog = useCallback(() => {
    api.tags
      .listManual()
      .then(setManualCatalog)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refreshManualCatalog()
  }, [refreshManualCatalog])

  const filteredManualCatalog = useMemo(() => {
    const query = draft.trim().toLowerCase()
    if (!query) return manualCatalog
    return manualCatalog.filter((tag) => tag.name.toLowerCase().includes(query))
  }, [manualCatalog, draft])

  const closeAddModal = useCallback((): void => {
    if (busy) return
    setAddOpen(false)
    setDraft('')
  }, [busy])

  useEffect(() => {
    if (!addOpen) return
    refreshManualCatalog()
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [addOpen, refreshManualCatalog])

  const addTagByName = async (name: string): Promise<boolean> => {
    const trimmed = name.trim()
    if (!trimmed || busy) return false
    setBusy(true)
    try {
      await api.videos.addManualTag(videoId, trimmed)
      setDraft('')
      refreshManualCatalog()
      onChanged()
      setAddOpen(false)
      return true
    } catch (e) {
      toast.show(String((e as Error).message ?? e), 'error')
      return false
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tag: VideoTag): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await api.videos.removeManualTag(videoId, tag.id)
      setRemoveTarget(null)
      refreshManualCatalog()
      onChanged()
      toast.show(`已移除自定义标签「${tag.name}」`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message ?? e), 'error')
    } finally {
      setBusy(false)
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
              onClick={() => setRemoveTarget(tag)}
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
          onClick={() => setAddOpen(true)}
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
          onConfirm={() => void addTagByName(draft)}
        >
          <div className="video-tag-add-modal-body">
            <div className="video-tag-add-modal-field">
              <label className="settings-form-label" htmlFor={`video-tag-add-input-${videoId}`}>
                标签名称
              </label>
              <input
                ref={inputRef}
                id={`video-tag-add-input-${videoId}`}
                className="text-input video-tag-add-modal-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="输入自定义标签名称"
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void addTagByName(draft)
                  }
                }}
              />
            </div>

            <section className="video-tag-add-modal-catalog" aria-label="已有自定义标签">
              <div className="video-tag-add-modal-catalog-head">
                <span className="app-form-section-title">已有自定义标签</span>
                <span className="video-tag-add-modal-catalog-count">
                  {draft.trim()
                    ? `${filteredManualCatalog.length} / ${manualCatalog.length}`
                    : manualCatalog.length}
                </span>
              </div>
              <div className="video-tag-add-modal-catalog-scroll">
                {manualCatalog.length === 0 ? (
                  <EmptyState
                    variant="modal"
                    className="video-tag-add-modal-empty"
                    icon={<Tags {...UI_ICON_SM} aria-hidden />}
                    title={'\u6682\u65e0\u5df2\u6709\u6807\u7b7e'}
                    description={'\u53ef\u5728\u4e0a\u65b9\u8f93\u5165\u65b0\u540d\u79f0\u521b\u5efa\u6807\u7b7e\u3002'}
                  />
                ) : filteredManualCatalog.length === 0 ? (
                  <EmptyState
                    variant="modal"
                    className="video-tag-add-modal-empty"
                    icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                    title={'\u6ca1\u6709\u5339\u914d\u7684\u6807\u7b7e'}
                    description={'\u8c03\u6574\u5173\u952e\u8bcd\uff0c\u6216\u5728\u4e0a\u65b9\u76f4\u63a5\u521b\u5efa\u65b0\u6807\u7b7e\u3002'}
                  />
                ) : (
                  <div className="video-tag-add-modal-catalog-list">
                    {filteredManualCatalog.map((tag) => {
                      const onVideo = manualIdsOnVideo.has(tag.id)
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          className={`tag-chip tag-chip--custom-pick${onVideo ? ' is-on-video' : ''}`}
                          disabled={busy || onVideo}
                          onClick={() => void addTagByName(tag.name)}
                          title={
                            onVideo ? `已添加：${tag.name}` : `添加自定义标签：${tag.name}`
                          }
                          aria-pressed={onVideo}
                        >
                          {tag.name}
                        </button>
                      )
                    })}
                  </div>
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
            if (!busy) setRemoveTarget(null)
          }}
        >
          确定从本片移除自定义标签「{removeTarget.name}」？
        </Modal>
      )}
    </section>
  )
}
