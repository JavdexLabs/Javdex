import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { UI_ICON_SM } from './iconDefaults'

interface Props {
  id?: string
  aliases: string[]
  onChange: (aliases: string[]) => void
  /** When set, clicking an alias chip promotes it to main name. */
  onPromoteToMain?: (alias: string) => void
  disabled?: boolean
  'aria-describedby'?: string
}

function splitAliasParts(raw: string): string[] {
  return raw
    .split(/[,，、]/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function aliasKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '')
}

/** Removable tag chips for editing actress aliases. */
export default function AliasTagEditor({
  id,
  aliases,
  onChange,
  onPromoteToMain,
  disabled,
  'aria-describedby': ariaDescribedBy
}: Props): JSX.Element {
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addAliases = (parts: string[]): void => {
    if (!parts.length) return
    const next = [...aliases]
    const seen = new Set(next.map(aliasKey))
    for (const part of parts) {
      const key = aliasKey(part)
      if (seen.has(key)) continue
      seen.add(key)
      next.push(part)
    }
    if (next.length !== aliases.length) onChange(next)
  }

  const removeAt = (index: number): void => {
    onChange(aliases.filter((_, i) => i !== index))
  }

  const commitDraft = (): void => {
    if (!draft.trim()) return
    addAliases(splitAliasParts(draft))
    setDraft('')
  }

  return (
    <div
      className="alias-tag-editor"
      onClick={() => {
        if (!disabled) inputRef.current?.focus()
      }}
    >
      {aliases.map((alias, index) => (
        <span
          key={`${alias}-${index}`}
          className={`alias-tag-chip${onPromoteToMain ? ' alias-tag-chip--promotable' : ''}`}
        >
          {onPromoteToMain ? (
            <button
              type="button"
              className="alias-tag-chip-name"
              onClick={(e) => {
                e.stopPropagation()
                onPromoteToMain(alias)
              }}
              disabled={disabled}
              title={`将「${alias}」设为主名`}
            >
              {alias}
            </button>
          ) : (
            <span className="alias-tag-chip-name">{alias}</span>
          )}
          <button
            type="button"
            className="alias-tag-chip-remove"
            onClick={(e) => {
              e.stopPropagation()
              removeAt(index)
            }}
            disabled={disabled}
            aria-label={`移除别名 ${alias}`}
          >
            <X {...UI_ICON_SM} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        className="alias-tag-editor-input"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commitDraft()
          } else if (e.key === 'Backspace' && !draft && aliases.length > 0) {
            removeAt(aliases.length - 1)
          }
        }}
        onBlur={commitDraft}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text')
          if (!/[,，、]/.test(text)) return
          e.preventDefault()
          addAliases(splitAliasParts(text))
          setDraft('')
        }}
        placeholder={aliases.length ? '添加别名…' : '输入后按 Enter 添加'}
        aria-label="添加别名"
        aria-describedby={ariaDescribedBy}
      />
    </div>
  )
}
