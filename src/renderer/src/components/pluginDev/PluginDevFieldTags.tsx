import { allFieldIdsForKind, fieldLabelForKind } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'
import { X } from 'lucide-react'
import { UI_ICON_SM } from '../iconDefaults'

export { allFieldIdsForKind } from '@shared/pluginDevKindProfile'

export function isAllSupportedFieldsSelected(
  supportedFieldIds: readonly string[],
  allFieldIds: readonly string[]
): boolean {
  return (
    supportedFieldIds.length === 0 ||
    (supportedFieldIds.length === allFieldIds.length &&
      allFieldIds.every((field) => supportedFieldIds.includes(field)))
  )
}

export function effectiveSupportedFieldIds(
  supportedFieldIds: readonly string[],
  allFieldIds: readonly string[]
): string[] {
  if (supportedFieldIds.length === 0) return [...allFieldIds]
  return [...supportedFieldIds]
}

export function normalizeSupportedFieldIds(
  supportedFieldIds: string[],
  allFieldIds: readonly string[]
): string[] {
  if (supportedFieldIds.length === 0) return []
  if (
    supportedFieldIds.length === allFieldIds.length &&
    allFieldIds.every((field) => supportedFieldIds.includes(field))
  ) {
    return []
  }
  return supportedFieldIds
}

export default function PluginDevFieldTags({
  kind,
  supportedFieldIds,
  fieldLabel,
  busy,
  onChange
}: {
  kind: PluginKind
  supportedFieldIds: string[]
  fieldLabel?: (kind: PluginKind, field: string) => string
  busy: boolean
  onChange: (fieldIds: string[]) => void
}): JSX.Element {
  const labelForField = fieldLabel ?? fieldLabelForKind
  const allFieldIds = allFieldIdsForKind(kind)
  const showAllChip = supportedFieldIds.length === 0
  const selectedIds = showAllChip ? [] : supportedFieldIds
  const effectiveSelected = effectiveSupportedFieldIds(supportedFieldIds, allFieldIds)
  const availableToAdd = allFieldIds.filter((field) => !effectiveSelected.includes(field))

  const removeAllChip = (): void => {
    onChange([...allFieldIds])
  }

  const removeField = (field: string): void => {
    const base = supportedFieldIds.length === 0 ? [...allFieldIds] : [...supportedFieldIds]
    const next = base.filter((item) => item !== field)
    onChange(normalizeSupportedFieldIds(next, allFieldIds))
  }

  const addField = (field: string): void => {
    if (!field || effectiveSelected.includes(field)) return
    const base = supportedFieldIds.length === 0 ? [...allFieldIds] : [...supportedFieldIds]
    onChange(normalizeSupportedFieldIds([...base, field], allFieldIds))
  }

  return (
    <div className="plugin-edit-control plugin-dev-field-tags plugin-dev-field-tags--inline">
      <span>支持字段</span>
      <div className="plugin-dev-field-tags-list">
        {showAllChip ? (
          <span className="plugin-dev-field-tag plugin-dev-field-tag--editable">
            <span className="plugin-dev-field-tag-label">全部字段</span>
            <button
              type="button"
              className="plugin-dev-field-tag-remove"
              disabled={busy}
              aria-label="自定义支持字段"
              title="展开后可逐个删除字段"
              onClick={removeAllChip}
            >
              <X {...UI_ICON_SM} />
            </button>
          </span>
        ) : (
          selectedIds.map((field) => (
            <span key={field} className="plugin-dev-field-tag plugin-dev-field-tag--editable">
              <span className="plugin-dev-field-tag-label">{labelForField(kind, field)}</span>
              <button
                type="button"
                className="plugin-dev-field-tag-remove"
                disabled={busy}
                aria-label={`移除字段 ${labelForField(kind, field)}`}
                onClick={() => removeField(field)}
              >
                <X {...UI_ICON_SM} />
              </button>
            </span>
          ))
        )}
      </div>
      {availableToAdd.length > 0 && (
        <select
          className="select plugin-dev-field-add"
          value=""
          disabled={busy}
          onChange={(e) => {
            addField(e.target.value)
            e.target.value = ''
          }}
        >
          <option value="" disabled hidden>
            添加字段…
          </option>
          {availableToAdd.map((field) => (
            <option key={field} value={field}>
              {labelForField(kind, field)}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}
