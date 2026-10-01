import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import Button from './Button'
import styles from './ImageImportField.module.css'

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
    <div className={styles.previewBox} data-shape={previewShape}>
      {displayUrl ? (
        <img src={displayUrl} alt="" className={styles.preview} />
      ) : (
        <div className={styles.placeholder}>无封面</div>
      )}
    </div>
  )

  const actions = (
    <div className={styles.actions}>
      <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>
        选择图片
      </Button>
      {previewUrl && (
        <Button type="button" variant="ghost" size="sm" onClick={clearPick}>
          取消选择
        </Button>
      )}
      {extraActions}
    </div>
  )

  const field = (
    <div className={styles.field} data-image-import-field data-layout={layout}>
      {layout === 'inline' ? (
        <>
          {preview}
          <div className={styles.side}>
            {hint ? <p className={styles.hint}>{hint}</p> : null}
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
      <label className={styles.label}>{label}</label>
      {field}
    </>
  )
}
