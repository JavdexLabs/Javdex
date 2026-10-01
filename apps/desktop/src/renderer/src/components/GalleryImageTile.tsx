import type { CSSProperties } from 'react'
import MediaTileActionButton from './MediaTileActionButton'
import styles from './GalleryImageTile.module.css'

interface GalleryImageTileProps {
  variant: 'sample' | 'actress'
  src: string
  label: string
  disabled: boolean
  onOpen: () => void
  onImageLoad?: (image: HTMLImageElement) => void
  deleteLabel: string
  deleteTitle: string
  onDelete: () => void
  style?: CSSProperties
}

/** Shared image tile styling; gallery layout and preview state stay with each owner. */
export default function GalleryImageTile({
  variant,
  src,
  label,
  disabled,
  onOpen,
  onImageLoad,
  deleteLabel,
  deleteTitle,
  onDelete,
  style
}: GalleryImageTileProps): JSX.Element {
  return (
    <div className={styles.root} data-gallery-variant={variant} data-media-tile style={style}>
      <button type="button" className={styles.button} disabled={disabled} onClick={onOpen} aria-label={label}>
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onLoad={onImageLoad ? (event) => onImageLoad(event.currentTarget) : undefined}
        />
      </button>
      <MediaTileActionButton label={deleteLabel} title={deleteTitle} onClick={onDelete} />
    </div>
  )
}
