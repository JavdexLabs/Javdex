import { useEffect, useId, useRef } from 'react'
import { Circle, CircleDot, Plus, Trash2, Undo2, X } from 'lucide-react'
import Button from './Button'
import IconButton from './IconButton'
import TextInput from './TextInput'
import { EditFormSection } from './FormPrimitives'
import {
  canSelectExternalRating, externalRatingsDraftErrors, reconcileExternalRatingsDraft,
  type ExternalRatingDraftRow, type ExternalRatingsDraft
} from './externalRatingsDraft'
import styles from './ExternalRatingsEditor.module.css'

export default function ExternalRatingsEditor({ value, disabled, onChange }: {
  value: ExternalRatingsDraft
  disabled: boolean
  onChange: (value: ExternalRatingsDraft) => void
}): JSX.Element {
  const id = useId()
  const nextKey = useRef(0)
  const addButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const sources = useRef(new Map<string, HTMLInputElement>())
  const errors = externalRatingsDraftErrors(value)
  const showErrors = (row: ExternalRatingDraftRow): boolean => Boolean(row.original || row.source.trim() || row.score.trim() || row.count.trim())
  const firstError = value.rows.findIndex((row) => showErrors(row) && errors.has(row.key))
  useEffect(() => {
    if (!pendingFocus.current) return
    if (pendingFocus.current === 'add') addButton.current?.focus()
    else sources.current.get(pendingFocus.current)?.focus()
    pendingFocus.current = null
  }, [value.rows])
  const update = (key: string, patch: Partial<ExternalRatingDraftRow>): void => {
    const next = { ...value, rows: value.rows.map((row) => row.key === key ? { ...row, ...patch } : row) }
    // Keep the default attached while the user replaces text; deletions choose a fallback immediately.
    onChange('removed' in patch || value.defaultKey === null ? reconcileExternalRatingsDraft(next) : next)
  }

  return (
    <EditFormSection title="外部评分" hint="默认来源用于详情页展示，保存后生效。"
      actions={<Button ref={addButton} size="sm" aria-label="新增评分" disabled={disabled || value.rows.length >= 200} onClick={() => {
        const key = `new-${nextKey.current++}`
        pendingFocus.current = key
        onChange({ ...value, rows: [...value.rows, { key, original: null, source: '', score: '', count: '', removed: false }] })
      }}><Plus size={14} aria-hidden />新增评分</Button>}>
      <div className={styles.tableWrap}>
        <table className={styles.table} aria-label="外部评分来源">
          <colgroup>
            <col className={styles.choiceColumn} /><col /><col className={styles.scoreColumn} />
            <col className={styles.countColumn} /><col className={styles.actionColumn} />
          </colgroup>
          <thead><tr>
            <th scope="col" className={styles.headingCell}>默认</th><th scope="col" className={styles.headingCell}>来源</th>
            <th scope="col" className={styles.headingCell}>评分</th><th scope="col" className={styles.headingCell}>评分人数</th>
            <th scope="col" className={`${styles.headingCell} ${styles.actionCell}`}>操作</th>
          </tr></thead>
          <tbody>
            {value.rows.length === 0 ? <tr><td colSpan={5} className={`${styles.cell} ${styles.empty}`}>暂无外部评分，点击“新增评分”添加。</td></tr> :
              value.rows.map((row, index) => {
                const name = row.source.trim() || `新增评分 ${index + 1}`
                const fields = showErrors(row) ? errors.get(row.key) : undefined
                const inputProps = (field: 'source' | 'score' | 'count') => ({
                  disabled: disabled || row.removed, 'aria-invalid': Boolean(fields?.[field]),
                  'aria-describedby': fields?.[field] ? `${id}-error` : undefined,
                  className: `${styles.input}${row.removed ? ` ${styles.removedInput}` : ''}${fields?.[field] ? ` ${styles.invalid}` : ''}`
                })
                return <tr key={row.key}>
                  <td className={`${styles.cell} ${styles.choiceCell}`}><label className={`${styles.choice}${disabled || !canSelectExternalRating(row) ? ` ${styles.choiceDisabled}` : ''}`}>
                    <input className={styles.choiceInput} type="radio" name={`${id}-default`} checked={value.defaultKey === row.key}
                      disabled={disabled || !canSelectExternalRating(row)}
                      aria-label={`将 ${name} 设为默认外部评分`}
                      onChange={() => onChange({ ...value, defaultKey: row.key })} />
                    {value.defaultKey === row.key ?
                      <CircleDot size={18} aria-hidden className={`${styles.choiceIcon} ${styles.selectedChoiceIcon}`} /> :
                      <Circle size={18} aria-hidden className={styles.choiceIcon} />}
                  </label></td>
                  <td className={styles.cell}><TextInput {...inputProps('source')} aria-label={`来源 ${index + 1}`} maxLength={256}
                    ref={(element) => { if (element) sources.current.set(row.key, element); else sources.current.delete(row.key) }}
                    placeholder="输入来源" value={row.source} onChange={(event) => update(row.key, { source: event.target.value })} /></td>
                  <td className={styles.cell}><TextInput {...inputProps('score')} aria-label={`评分 ${index + 1}`} inputMode="decimal"
                    placeholder={row.original ? '未提供' : '评分'} value={row.score}
                    onChange={(event) => update(row.key, { score: event.target.value })}
                    onBlur={() => onChange(reconcileExternalRatingsDraft(value))} /></td>
                  <td className={styles.cell}><TextInput {...inputProps('count')} aria-label={`评分人数 ${index + 1}`} inputMode="numeric"
                    placeholder={row.original ? '未提供' : '可选'} value={row.count}
                    onChange={(event) => update(row.key, { count: event.target.value })} /></td>
                  <td className={`${styles.cell} ${styles.actionCell}`}><IconButton size="control"
                    label={`${row.removed ? '撤销删除' : row.original ? '删除' : '移除'} ${name} 评分`}
                    title={row.removed ? '待删除，点击撤销' : row.original ? '删除评分，保存前可撤销' : '移除此新增行'}
                    tone={row.removed ? 'accent' : 'default'} disabled={disabled}
                    icon={row.removed ? <Undo2 size={14} aria-hidden /> : row.original ? <Trash2 size={14} aria-hidden /> : <X size={14} aria-hidden />}
                    onClick={() => {
                      if (row.original) update(row.key, { removed: !row.removed })
                      else {
                        pendingFocus.current = value.rows.slice(index + 1).find((item) => !item.removed)?.key ??
                          value.rows.slice(0, index).reverse().find((item) => !item.removed)?.key ?? 'add'
                        onChange(reconcileExternalRatingsDraft({ ...value, rows: value.rows.filter((item) => item.key !== row.key) }))
                      }
                    }} /></td>
                </tr>
              })}
          </tbody>
        </table>
      </div>
      <p id={`${id}-error`} className={`${styles.feedback}${firstError >= 0 ? ` ${styles.error}` : ''}`} role="status">
        {firstError >= 0 ? `第 ${firstError + 1} 行：${Object.values(errors.get(value.rows[firstError].key)!)[0]}。` :
          value.rows.some((row) => row.removed) ? '待删除的评分已变灰；点击撤销图标可恢复。' :
            value.rows.some((row) => !row.original) ? '填写来源和评分；人数可留空。' : '评分人数可留空。'}
      </p>
    </EditFormSection>
  )
}
