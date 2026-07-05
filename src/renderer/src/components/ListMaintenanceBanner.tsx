import { X } from 'lucide-react'
import { UI_ICON_SM } from './iconDefaults'
import IconButton from './IconButton'

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
    <div className={`list-maintenance-banner${className ? ` ${className}` : ''}`} role="status">
      <div className="list-maintenance-banner-copy">
        <strong>{title}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <div className="list-maintenance-banner-actions">
        <button
          type="button"
          className="btn btn-sm"
          disabled={secondaryDisabled}
          onClick={onSecondary}
        >
          {secondaryLabel}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={primaryDisabled}
          title={primaryDisabled ? primaryDisabledReason : undefined}
          onClick={onPrimary}
        >
          {primaryLabel}
        </button>
        {onDismiss ? (
          <IconButton
            className="list-maintenance-banner-dismiss"
            icon={<X {...UI_ICON_SM} />}
            label="关闭提示"
            onClick={onDismiss}
          />
        ) : null}
      </div>
    </div>
  )
}
