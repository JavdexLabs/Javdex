import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'

interface Props {
  label: string
  currentUrl: string | null
  onSourcePathChange: (path: string | null) => void
  previewShape?: 'wide' | 'square'
  hideLabel?: boolean
  /** stack: preview above actions; inline: preview beside actions (entity edit cover). */
  layout?: 'stack' | 'inline'
  hint?: string
  extraActions?: ReactNode
}

/** Local image picker with preview for metadata edit forms. */
export default function ImageImportField({
  label,
  currentUrl,
  onSourcePathChange,
  previewShape = 'wide',
  hideLabel = false,
  layout = 'stack',
  hint,
  extraActions
}: Props): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const previewRef = useRef<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (previewRef.current?.startsWith('blob:')) {
        URL.revokeObjectURL(previewRef.current)
      }
    }
  }, [])

  const setPreview = (url: string | null): void => {
    if (previewRef.current?.startsWith('blob:') && previewRef.current !== url) {
      URL.revokeObjectURL(previewRef.current)
    }
    previewRef.current = url
    setPreviewUrl(url)
  }

  const clearPick = (): void => {
    setPreview(null)
    onSourcePathChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file) return
    setPreview(URL.createObjectURL(file))
    onSourcePathChange(api.assets.getPathForFile(file))
  }

  const displayUrl = previewUrl || currentUrl

  const preview = (
    <div className={`image-import-preview-box image-import-preview-box--${previewShape}`}>
      {displayUrl ? (
        <img src={displayUrl} alt="" className="image-import-preview" />
      ) : (
        <div className="image-import-placeholder">无封面</div>
      )}
    </div>
  )

  const actions = (
    <div className="image-import-actions">
      <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
        选择图片
      </button>
      {previewUrl && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={clearPick}>
          取消选择
        </button>
      )}
      {extraActions}
    </div>
  )

  const field = (
    <div
      className={[
        'image-import-field',
        hideLabel ? 'image-import-field--embedded' : '',
        layout === 'inline' ? 'image-import-field--inline' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {layout === 'inline' ? (
        <>
          {preview}
          <div className="image-import-side">
            {hint ? <p className="image-import-hint">{hint}</p> : null}
            {actions}
          </div>
        </>
      ) : (
        <>
          {preview}
          {actions}
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,.jpg,.jpeg,.png,.webp,.gif,.avif"
        hidden
        onChange={onFileChange}
      />
    </div>
  )

  if (hideLabel) return field

  return (
    <>
      <label style={{ alignSelf: 'start', paddingTop: 8 }}>{label}</label>
      {field}
    </>
  )
}
