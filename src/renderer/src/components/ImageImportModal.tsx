import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ImagePlus, Link, UploadCloud } from 'lucide-react'
import { api } from '../api'
import MediaTileDeleteButton from './MediaTileDeleteButton'
import Modal from './Modal'
import { useToast } from './Toast'
import { UI_ICON } from './iconDefaults'

const IMAGE_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif'
const IMAGE_EXT_RE = /\.(avif|gif|jpe?g|png|webp)$/i

interface QueuedImportImage {
  key: string
  name: string
  sourcePath?: string
  remoteUrl?: string
  previewUrl: string
  previewObjectUrl?: boolean
}

interface ImageImportModalProps {
  title: string
  itemLabel: string
  emptyText: string
  urlHint: string
  onCancel: () => void
  onChanged: () => void
  onImportFilePath: (sourcePath: string) => Promise<unknown>
  onImportUrl: (remoteUrl: string) => Promise<unknown>
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name)
}

function fileKey(file: File, sourcePath: string): string {
  return sourcePath || `${file.name}:${file.size}:${file.lastModified}`
}

function remoteImageName(url: string): string {
  try {
    const parsed = new URL(url)
    const lastSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '')
    return lastSegment || parsed.hostname
  } catch {
    return url
  }
}

function loadRemoteImage(url: string): Promise<string> {
  return api.assets.fetchRemoteImagePreview(url).then(({ mimeType, dataBase64 }) => {
    return `data:${mimeType};base64,${dataBase64}`
  })
}

export default function ImageImportModal({
  title,
  itemLabel,
  emptyText,
  urlHint,
  onCancel,
  onChanged,
  onImportFilePath,
  onImportUrl
}: ImageImportModalProps): JSX.Element {
  const toast = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queuedRef = useRef<QueuedImportImage[]>([])
  const [mode, setMode] = useState<'file' | 'url'>('file')
  const [queued, setQueued] = useState<QueuedImportImage[]>([])
  const [urlInput, setUrlInput] = useState('')
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadingUrl, setLoadingUrl] = useState(false)

  useEffect(() => {
    queuedRef.current = queued
  }, [queued])

  useEffect(() => {
    return () => {
      queuedRef.current.forEach((item) => {
        if (item.previewObjectUrl) URL.revokeObjectURL(item.previewUrl)
      })
    }
  }, [])

  const canSave = queued.length > 0

  const appendFiles = (fileList: FileList | File[]): void => {
    const incoming = Array.from(fileList).filter(isImageFile)
    if (incoming.length === 0) {
      toast.show('没有可导入的图片文件', 'error')
      return
    }

    setQueued((current) => {
      const keys = new Set(current.map((item) => item.key))
      const next = [...current]

      incoming.forEach((file) => {
        const sourcePath = api.assets.getPathForFile(file)
        const key = fileKey(file, sourcePath)
        if (keys.has(key)) return
        keys.add(key)
        next.push({
          key,
          name: file.name,
          sourcePath,
          previewUrl: URL.createObjectURL(file),
          previewObjectUrl: true
        })
      })

      return next
    })
  }

  const removeQueued = (key: string): void => {
    setQueued((current) => {
      const target = current.find((item) => item.key === key)
      if (target?.previewObjectUrl) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.key !== key)
    })
  }

  const addRemoteImage = async (): Promise<void> => {
    const rawUrl = urlInput.trim()
    if (!rawUrl || loadingUrl) return

    let remoteUrl: string
    try {
      const parsed = new URL(rawUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('只支持 http 或 https 图片链接')
      }
      remoteUrl = parsed.toString()
    } catch (e) {
      toast.show(String((e as Error).message || '请输入有效的图片链接'), 'error')
      return
    }

    const key = `url:${remoteUrl}`
    if (queued.some((item) => item.key === key)) {
      toast.show('这个图片链接已在待导入列表中', 'error')
      return
    }

    setLoadingUrl(true)
    try {
      const previewUrl = await loadRemoteImage(remoteUrl)
      setQueued((current) => {
        if (current.some((item) => item.key === key)) return current
        return [
          ...current,
          {
            key,
            name: remoteImageName(remoteUrl),
            remoteUrl,
            previewUrl
          }
        ]
      })
      setUrlInput('')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setLoadingUrl(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    appendFiles(event.dataTransfer.files)
  }

  const handleImport = async (): Promise<void> => {
    if (!canSave || saving) return
    setSaving(true)
    let imported = 0
    try {
      for (const item of queued) {
        if (item.sourcePath) {
          await onImportFilePath(item.sourcePath)
        } else if (item.remoteUrl) {
          await onImportUrl(item.remoteUrl)
        } else {
          continue
        }
        imported += 1
      }
      toast.show(`已导入 ${imported} 张${itemLabel}`, 'success')
      onChanged()
      onCancel()
    } catch (e) {
      if (imported > 0) onChanged()
      toast.show(String((e as Error).message), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
        title={title}
        size="lg"
        className="image-import-modal"
        confirmText={saving ? '导入中...' : `导入${itemLabel}`}
        confirmDisabled={!canSave || saving || loadingUrl}
        onCancel={onCancel}
        onConfirm={() => void handleImport()}
      >
        <div className="image-import-shell">
          <div className="image-import-tabs" role="tablist" aria-label="导入方式">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'file'}
              className={mode === 'file' ? 'active' : ''}
              onClick={() => setMode('file')}
            >
              <UploadCloud {...UI_ICON} />
              本地图片
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'url'}
              className={mode === 'url' ? 'active' : ''}
              onClick={() => setMode('url')}
            >
              <Link {...UI_ICON} />
              图片链接
            </button>
          </div>

          {mode === 'file' ? (
            <div
              className={`image-import-dropzone${dragging ? ' is-dragging' : ''}`}
              onDragEnter={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                setDragging(false)
              }}
              onDrop={handleDrop}
            >
              <div className="image-import-dropzone__icon">
                <UploadCloud {...UI_ICON} />
              </div>
              <div>
                <div className="image-import-dropzone__title">拖入图片，或选择本地文件</div>
                <div className="image-import-dropzone__hint">
                  支持单张或多张，重复选择会追加到当前列表。
                </div>
              </div>
              <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus {...UI_ICON} />
                选择图片
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={IMAGE_ACCEPT}
                multiple
                hidden
                onChange={(event) => {
                  appendFiles(event.currentTarget.files ?? [])
                  event.currentTarget.value = ''
                }}
              />
            </div>
          ) : (
            <div className="image-import-url-panel">
              <div className="image-import-url-row">
                <input
                  className="text-input"
                  type="url"
                  value={urlInput}
                  onChange={(event) => setUrlInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void addRemoteImage()
                    }
                  }}
                  placeholder="输入一个图片链接"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void addRemoteImage()}
                  disabled={!urlInput.trim() || loadingUrl}
                >
                  <Link {...UI_ICON} />
                  {loadingUrl ? '加载中...' : '加载图片'}
                </button>
              </div>
              <div className="image-import-muted">{urlHint}</div>
            </div>
          )}

          <div className="image-import-gallery-head">
            <div>
              <h4>待导入预览</h4>
              <p>{queued.length} 张待导入</p>
            </div>
          </div>

          <div className="image-import-gallery" aria-label={`${itemLabel}图片预览`}>
            {queued.length === 0 ? (
              <div className="image-import-empty">{emptyText}</div>
            ) : (
              queued.map((item, index) => (
                <div key={item.key} className="image-import-tile">
                  <div className="image-import-thumb" aria-hidden="true">
                    <img src={item.previewUrl} alt="" loading="lazy" draggable={false} />
                  </div>
                  <MediaTileDeleteButton
                    label={`移除待导入图片 ${index + 1}`}
                    title="移除图片"
                    onClick={() => removeQueued(item.key)}
                  />
                  <div className="image-import-name" title={item.name}>{item.name}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>
  )
}
