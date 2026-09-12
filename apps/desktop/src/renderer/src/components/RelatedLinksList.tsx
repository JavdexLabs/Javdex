import { ExternalLink } from 'lucide-react'
import type { RelatedLink } from '@shared/relatedLinkTypes'
import { UI_ICON_SM } from './iconDefaults'

export default function RelatedLinksList({
  links
}: {
  links: readonly RelatedLink[]
}): JSX.Element | null {
  if (links.length === 0) return null
  return (
    <div className="organization-links selectable-text">
      {links.map((link) => (
        <a
          key={`${link.position}:${link.url}`}
          href={link.url}
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
