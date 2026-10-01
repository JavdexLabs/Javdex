import type { ReactNode } from 'react'
import type { RelatedLink } from '@shared/relatedLinkTypes'
import RelatedLinksList from './RelatedLinksList'
import styles from './ClassificationProfile.module.css'

interface Props {
  kind: 'director' | 'series' | 'organization'
  label: string
  kicker: string
  name: string
  imageUrl: string | null
  placeholder: ReactNode
  meta?: ReactNode
  aliases: readonly string[]
  summary?: string | null
  links: readonly RelatedLink[]
}

export default function ClassificationProfile({
  kind,
  label,
  kicker,
  name,
  imageUrl,
  placeholder,
  meta,
  aliases,
  summary,
  links
}: Props): JSX.Element {
  return (
    <section className={styles.root} aria-label={label}>
      <div className={styles.image} data-kind={kind}>
        {imageUrl ? <img src={imageUrl} alt="" /> : placeholder}
      </div>
      <div className={styles.main}>
        <div className={styles.kicker}>{kicker}</div>
        <h1 className={styles.title}>{name}</h1>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
        {aliases.length > 0 ? (
          <div className={styles.aliases}>
            {aliases.map((alias) => <span key={alias}>{alias}</span>)}
          </div>
        ) : null}
        <p className={`${styles.summary}${summary ? '' : ` ${styles.summaryEmpty}`}`}>
          {summary ?? '暂无简介'}
        </p>
        <RelatedLinksList links={links} />
      </div>
    </section>
  )
}
