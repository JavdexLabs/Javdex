import type { ReactNode } from 'react'
import Button from '../Button'
import styles from './SettingsFormActions.module.css'

export default function SettingsFormActions({
  dirty,
  saving = false,
  idleLabel = '已保存',
  disabled = false,
  error,
  conflict,
  placement = 'footer',
  onSave,
  onCancel,
  children
}: {
  dirty: boolean
  saving?: boolean
  idleLabel?: string
  disabled?: boolean
  error?: string | null
  conflict?: boolean
  placement?: 'footer' | 'header'
  onSave: () => void
  onCancel: () => void
  children?: ReactNode
}): JSX.Element {
  return (
    <div className={styles.root} data-placement={placement}>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {conflict ? (
        <p className={styles.error} role="status">
          已保存的配置发生变化。你的输入已保留；取消更改可读取最新值。
        </p>
      ) : null}
      <div className={styles.actions}>
        <span className={styles.status} role="status">
          {saving ? '保存中…' : dirty ? '有未保存的更改' : idleLabel}
        </span>
        {children}
        {dirty ? (
          <Button size="sm" disabled={saving || disabled} onClick={onCancel}>
            取消更改
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'default'}
          disabled={!dirty || saving || disabled}
          onClick={onSave}
        >
          保存
        </Button>
      </div>
    </div>
  )
}
