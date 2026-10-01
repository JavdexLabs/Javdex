import type { ReactNode } from 'react'
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
    <div className={styles.wrap}>
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
        <div className={styles.name}>{name}</div>
        {subtitle ? <div className={styles.subtitle}>{subtitle}</div> : null}
        <div className={styles.count}>{videoCount} 部</div>
      </button>
    </div>
  )
}
