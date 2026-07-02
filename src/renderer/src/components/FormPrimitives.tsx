import type { ReactNode } from 'react'

/** Shared form field layout (same tokens as settings forms). */
export function AppFormField({
  label,
  hint,
  children,
  className = ''
}: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <label className={`settings-form-field${className ? ` ${className}` : ''}`}>
      <span className="settings-form-label">{label}</span>
      {children}
      {hint ? <small className="settings-form-hint">{hint}</small> : null}
    </label>
  )
}

/** Section block inside form modals (matches plugin config panels). */
export function AppFormSection({
  title,
  hint,
  actions,
  className = '',
  children
}: {
  title: ReactNode
  hint?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`app-form-section${className ? ` ${className}` : ''}`}>
      <div className="app-form-section-head">
        <div className="app-form-section-copy">
          <h4 className="app-form-section-title">{title}</h4>
          {hint ? <p className="app-form-section-hint">{hint}</p> : null}
        </div>
        {actions ? <div className="app-form-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Bordered section inside entity edit modals (actress / video metadata). */
export function EditFormSection({
  title,
  className = '',
  children
}: {
  title: string
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className={`entity-edit-section${className ? ` ${className}` : ''}`}>
      <h4 className="entity-edit-section-title">{title}</h4>
      {children}
    </section>
  )
}

/** Label + control row inside entity edit modals. */
export function EditFormField({
  label,
  htmlFor,
  span = 1,
  labelExtra,
  hint,
  children
}: {
  label: ReactNode
  htmlFor?: string
  span?: 1 | 2
  labelExtra?: ReactNode
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className={`entity-edit-field${span === 2 ? ' entity-edit-field--full' : ''}`}>
      <label htmlFor={htmlFor} className="entity-edit-label">
        <span>{label}</span>
        {labelExtra}
      </label>
      {children}
      {hint ? <span className="entity-edit-field-hint">{hint}</span> : null}
    </div>
  )
}
