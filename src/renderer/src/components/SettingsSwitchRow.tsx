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
    <label className={`settings-toggle-item${disabled ? ' settings-toggle-item--disabled' : ''}`}>
      <span className="settings-toggle-copy">
        <span className="settings-toggle-title">{title}</span>
        {description ? <span className="settings-toggle-desc">{description}</span> : null}
      </span>
      <span className="ui-switch">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="ui-switch-slider" aria-hidden="true" />
      </span>
    </label>
  )
}
