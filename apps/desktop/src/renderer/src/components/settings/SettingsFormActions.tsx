import type { ReactNode } from 'react'
import Button from '../Button'
import SettingsFeedback from './SettingsFeedback'
import styles from './SettingsFormActions.module.css'

export default function SettingsFormActions({
  dirty,
  saving = false,
  idleLabel = '已保存',
  saveLabel = '保存',
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
  saveLabel?: string
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
      <div className={styles.actions} data-placement={placement}>
        <div className={styles.status} data-placement={placement}>
          <SettingsFeedback error={Boolean(error || conflict)}
            message={error || (conflict ? '已保存的配置发生变化。你的输入已保留；取消更改可读取最新值。'
              : saving ? '保存中…' : dirty ? '有未保存的更改' : idleLabel)}
            detail={[error, conflict ? '已保存的配置发生变化。你的输入已保留；取消更改可读取最新值。' : null].filter(Boolean).join('\n') || null} />
        </div>
        {children}
          <Button size="sm" className={!dirty ? styles.hidden : undefined} tabIndex={dirty ? 0 : -1} aria-hidden={!dirty} disabled={!dirty || saving || disabled} onClick={onCancel}>
            取消更改
          </Button>
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'default'}
          disabled={!dirty || saving || disabled}
          onClick={onSave}
        >
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}
