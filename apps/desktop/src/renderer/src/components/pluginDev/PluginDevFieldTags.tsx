import { allFieldIdsForKind, fieldLabelForKind } from '@shared/pluginDevKindProfile'
import type { PluginKind } from './types'
import ChipRemoveButton from '../ChipRemoveButton'
import SelectControl from '../SelectControl'
import styles from './PluginDevFieldTags.module.css'

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
  className = '',
  onChange
}: {
  kind: PluginKind
  supportedFieldIds: string[]
  fieldLabel?: (kind: PluginKind, field: string) => string
  busy: boolean
  className?: string
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
    <div className={`${styles.root}${className ? ` ${className}` : ''}`}>
      <span className={styles.label}>支持字段</span>
      <div className={styles.list}>
        {showAllChip ? (
          <span className={styles.chip} data-chip-remove-host>
            <span className={styles.chipLabel}>全部字段</span>
            <ChipRemoveButton
              disabled={busy}
              label="自定义支持字段"
              reveal="always"
              title="展开后可逐个删除字段"
              onClick={removeAllChip}
            />
          </span>
        ) : (
          selectedIds.map((field) => (
            <span key={field} className={styles.chip} data-chip-remove-host>
              <span className={styles.chipLabel}>{labelForField(kind, field)}</span>
              <ChipRemoveButton
                disabled={busy}
                label={`移除字段 ${labelForField(kind, field)}`}
                reveal="always"
                onClick={() => removeField(field)}
              />
            </span>
          ))
        )}
      </div>
      {availableToAdd.length > 0 && (
        <SelectControl
          className={styles.add}
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
        </SelectControl>
      )}
    </div>
  )
}
