import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import IconButton from '../IconButton'
import { UI_ICON_MD } from '../iconDefaults'
import { SettingsFormField } from './SettingsPrimitives'

export default function SettingsInlineUrlField({
  label,
  savedValue,
  placeholder,
  emptyHint,
  saving,
  testing,
  missingHint,
  onDraftChange,
  onSave,
  onTest
}: {
  label: string
  savedValue: string
  placeholder: string
  emptyHint: string
  saving: boolean
  testing?: boolean
  missingHint?: boolean
  onDraftChange: (value: string) => void
  onSave: (value: string) => Promise<boolean>
  onTest?: (value: string) => Promise<void>
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(savedValue)

  useEffect(() => {
    if (!editing) setDraft(savedValue)
  }, [savedValue, editing])

  const beginEdit = (): void => {
    setDraft(savedValue)
    onDraftChange(savedValue)
    setEditing(true)
    window.requestAnimationFrame(() => inputRef.current?.focus())
  }

  const cancelEdit = (): void => {
    setDraft(savedValue)
    onDraftChange(savedValue)
    setEditing(false)
    inputRef.current?.blur()
  }

  const commitSave = async (): Promise<void> => {
    if (saving) return
    const ok = await onSave(draft)
    if (ok) setEditing(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!editing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      void commitSave()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    }
  }

  const handleDraftChange = (value: string): void => {
    setDraft(value)
    onDraftChange(value)
  }

  const isEmpty = !savedValue.trim()
  const displayEmpty = !editing && isEmpty
  const probeValue = (editing ? draft : savedValue).trim()
  const probeBusy = Boolean(testing)
  const probeDisabled = probeBusy || saving || !probeValue

  const runTest = async (): Promise<void> => {
    if (!onTest || probeDisabled) return
    await onTest(probeValue)
  }

  return (
    <SettingsFormField
      label={label}
      className="settings-form-field--inline"
      hint={missingHint ? '已启用但未填写地址，代理不会生效。' : undefined}
    >
      <div className="settings-inline-url-field">
        <div
          className={`settings-input-with-actions${editing ? ' settings-input-with-actions--editing' : ''}${displayEmpty ? ' settings-input-with-actions--empty' : ''}${!editing && !isEmpty ? ' settings-input-with-actions--filled' : ''}`}
        >
          <input
            ref={inputRef}
            className="text-input"
            placeholder={editing ? placeholder : emptyHint}
            value={editing ? draft : savedValue}
            readOnly={!editing}
            disabled={saving}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onDoubleClick={() => {
              if (!editing) beginEdit()
            }}
          />
          <div className="settings-input-with-actions__buttons">
            {editing ? (
              <>
                <IconButton
                  icon={<Check {...UI_ICON_MD} />}
                  label="保存"
                  className="settings-input-action-btn settings-input-action-btn--primary"
                  disabled={saving}
                  aria-busy={saving}
                  onClick={() => void commitSave()}
                />
                <IconButton
                  icon={<X {...UI_ICON_MD} />}
                  label="取消"
                  className="settings-input-action-btn"
                  disabled={saving}
                  onClick={cancelEdit}
                />
              </>
            ) : (
              <IconButton
                icon={<Pencil {...UI_ICON_MD} />}
                label="编辑"
                className="settings-input-action-btn"
                disabled={saving}
                onClick={beginEdit}
              />
            )}
          </div>
        </div>
        {onTest && (
          <div className="settings-inline-url-field__footer">
            <button
              type="button"
              className="btn btn-sm"
              disabled={probeDisabled}
              aria-busy={probeBusy}
              onClick={() => void runTest()}
            >
              {probeBusy ? '测试中…' : '测试连接'}
            </button>
          </div>
        )}
      </div>
    </SettingsFormField>
  )
}
