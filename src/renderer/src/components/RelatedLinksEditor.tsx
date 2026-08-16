import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type { RelatedLinkInput } from '@shared/relatedLinkTypes'
import { EditFormSection } from './FormPrimitives'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'
import Button from './Button'
import { moveClassificationLink, useClassificationLinkKeys } from './classificationLinkForm'

export default function RelatedLinksEditor({
  links,
  disabled = false,
  onChange
}: {
  links: RelatedLinkInput[]
  disabled?: boolean
  onChange: (links: RelatedLinkInput[]) => void
}): JSX.Element {
  const { linkKeys, moveLinkKey, removeLinkKey, appendLinkKey } = useClassificationLinkKeys(
    links.length
  )
  return (
    <EditFormSection title="相关链接">
      <div className="organization-link-editor">
        {links.map((link, index) => (
          <div className="organization-link-editor-row" key={linkKeys[index]}>
            <input
              className="text-input"
              aria-label={`链接 ${index + 1} 名称`}
              placeholder="名称"
              value={link.label}
              disabled={disabled}
              onChange={(event) => {
                const next = [...links]
                next[index] = { ...link, label: event.target.value }
                onChange(next)
              }}
            />
            <input
              className="text-input"
              aria-label={`链接 ${index + 1} 地址`}
              placeholder="https://"
              value={link.url}
              disabled={disabled}
              onChange={(event) => {
                const next = [...links]
                next[index] = { ...link, url: event.target.value }
                onChange(next)
              }}
            />
            <div className="organization-link-actions">
              <IconButton
                className="organization-link-action"
                icon={<ChevronUp {...UI_ICON_SM} aria-hidden />}
                label={`上移链接 ${index + 1}`}
                disabled={disabled || index === 0}
                onClick={() => {
                  onChange(moveClassificationLink(links, index, index - 1))
                  moveLinkKey(index, index - 1)
                }}
              />
              <IconButton
                className="organization-link-action"
                icon={<ChevronDown {...UI_ICON_SM} aria-hidden />}
                label={`下移链接 ${index + 1}`}
                disabled={disabled || index === links.length - 1}
                onClick={() => {
                  onChange(moveClassificationLink(links, index, index + 1))
                  moveLinkKey(index, index + 1)
                }}
              />
              <IconButton
                className="organization-link-action"
                tone="danger"
                icon={<Trash2 {...UI_ICON_SM} aria-hidden />}
                label={`删除链接 ${index + 1}`}
                disabled={disabled}
                onClick={() => {
                  onChange(links.filter((_, itemIndex) => itemIndex !== index))
                  removeLinkKey(index)
                }}
              />
            </div>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="organization-link-add"
          disabled={disabled}
          onClick={() => {
            onChange([...links, { label: '', url: '' }])
            appendLinkKey()
          }}
        >
          <Plus {...UI_ICON_SM} />
          添加链接
        </Button>
      </div>
    </EditFormSection>
  )
}

export function relatedLinksFromDraft(links: readonly RelatedLinkInput[]): RelatedLinkInput[] {
  return links.filter((link) => link.url.trim())
}
