import { ExternalLink } from 'lucide-react'
import type { RelatedLink } from '@shared/relatedLinkTypes'
import { UI_ICON_SM } from './iconDefaults'
import styles from './RelatedLinksList.module.css'

export default function RelatedLinksList({
  links,
  selectable = false
}: {
  links: readonly RelatedLink[]
  selectable?: boolean
}): JSX.Element | null {
  if (links.length === 0) return null
  return (
    <div className={styles.root} data-selectable={selectable || undefined}>
      {links.map((link) => (
        <a
          key={`${link.position}:${link.url}`}
          href={link.url}
          className={styles.link}
          onClick={(event) => {
            event.preventDefault()
            void window.api.externalLinks.open(link.url)
          }}
        >
          {link.label}
          <ExternalLink {...UI_ICON_SM} />
        </a>
      ))}
    </div>
  )
}
