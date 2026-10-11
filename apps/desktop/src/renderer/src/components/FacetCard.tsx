import type { CSSProperties, ReactNode } from 'react'
import styles from './FacetCard.module.css'

interface Props {
  kind: 'organization' | 'series' | 'director'
  name: string
  imageUrl: string | null
  placeholder: ReactNode
  subtitle?: string | null
  videoCount: number
  onOpen: () => void
}

const COVER_ASPECT = 1.49
const BORDER_WIDTH = 1
const META_HEIGHT = 62
const SERIES_META_HEIGHT = 80

/** Match the rendered cover, metadata block and borders to the virtual cell. */
export function facetCardHeight(width: number, kind: Props['kind']): number {
  return (width - BORDER_WIDTH * 2) / COVER_ASPECT
    + (kind === 'series' ? SERIES_META_HEIGHT : META_HEIGHT) + BORDER_WIDTH * 2
}

export default function FacetCard({
  kind,
  name,
  imageUrl,
  placeholder,
  subtitle,
  videoCount,
  onOpen
}: Props): JSX.Element {
  return (
    <div className={styles.wrap} style={{
      '--facet-cover-aspect': COVER_ASPECT,
      '--facet-meta-height': `${kind === 'series' ? SERIES_META_HEIGHT : META_HEIGHT}px`
    } as CSSProperties}>
      <button
        type="button"
        className={styles.card}
        data-facet-card="true"
        title={kind === 'organization' ? name : undefined}
        onClick={onOpen}
      >
        <div className={styles.thumb} data-kind={kind}>
          {imageUrl ? (
            <img src={imageUrl} alt="" loading="lazy" />
          ) : (
            <span className={styles.placeholder} aria-hidden>{placeholder}</span>
          )}
        </div>
        <div className={styles.metadata}>
          <div className={styles.name}>{name}</div>
          {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
          <div className={styles.count}>{videoCount} 部</div>
        </div>
      </button>
    </div>
  )
}
