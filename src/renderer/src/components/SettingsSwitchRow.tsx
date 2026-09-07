import Switch from './Switch'
import styles from './SettingsSwitchRow.module.css'

interface Props {
  title: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

/** Settings list row with label on the left and a switch control on the right. */
export default function SettingsSwitchRow({
  title,
  description,
  checked,
  disabled = false,
  onChange
}: Props): JSX.Element {
  return (
    <label
      className={`${styles.root}${disabled ? ` ${styles.disabled}` : ''} settings-toggle-item`}
    >
      <span className={styles.copy}>
        <span className={styles.title}>{title}</span>
        {description ? <span className={styles.description}>{description}</span> : null}
      </span>
      <Switch
        aria-label={title}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )
}
