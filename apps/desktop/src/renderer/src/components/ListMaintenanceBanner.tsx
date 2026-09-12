import { X } from 'lucide-react'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'
import Button from './Button'
import styles from './ListMaintenanceBanner.module.css'

export default function ListMaintenanceBanner({
  title,
  detail,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onDismiss,
  primaryDisabled = false,
  primaryDisabledReason,
  secondaryDisabled = false,
  className = ''
}: {
  title: string
  detail?: string
  primaryLabel: string
  secondaryLabel: string
  onPrimary: () => void
  onSecondary: () => void
  onDismiss?: () => void
  primaryDisabled?: boolean
  primaryDisabledReason?: string
  secondaryDisabled?: boolean
  className?: string
}): JSX.Element {
  return (
    <div className={`${styles.root}${className ? ` ${className}` : ''}`} role="status">
      <div className={styles.copy}>
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <div className={styles.actions}>
        <Button
          type="button"
          size="sm"
          disabled={secondaryDisabled}
          onClick={onSecondary}
        >
          {secondaryLabel}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={primaryDisabled}
          title={primaryDisabled ? primaryDisabledReason : undefined}
          onClick={onPrimary}
        >
          {primaryLabel}
        </Button>
        {onDismiss ? (
          <IconButton
            className={styles.dismiss}
            icon={<X {...UI_ICON_SM} />}
            label="关闭提示"
            onClick={onDismiss}
          />
        ) : null}
      </div>
    </div>
  )
}
