import type { ReactNode } from 'react'
import styles from './FormPrimitives.module.css'

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
    <label className={`${styles.formField} settings-form-field${className ? ` ${className}` : ''}`}>
      <span className={`${styles.formLabel} settings-form-label`}>{label}</span>
      {children}
      {hint ? <small className={`${styles.formHint} settings-form-hint`}>{hint}</small> : null}
    </label>
  )
}

/** Labelled choices with consistent spacing between the legend and controls. */
export function AppFormChoiceGroup({ label, children, disabled }: {
  label: string
  children: ReactNode
  disabled?: boolean
}): JSX.Element {
  return (
    <fieldset className={styles.choiceGroup} disabled={disabled}>
      <legend className={styles.choiceLegend}>{label}</legend>
      <div className={styles.choiceContent}>{children}</div>
    </fieldset>
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
    <section className={`${styles.formSection} app-form-section${className ? ` ${className}` : ''}`}>
      <div className={`${styles.sectionHead} app-form-section-head`}>
        <div className="app-form-section-copy">
          <h4 className={`${styles.sectionTitle} app-form-section-title`}>{title}</h4>
          {hint ? <p className={`${styles.sectionHint} app-form-section-hint`}>{hint}</p> : null}
        </div>
        {actions ? (
          <div className={`${styles.sectionActions} app-form-section-actions`}>{actions}</div>
        ) : null}
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
    <section className={`${styles.editSection} entity-edit-section${className ? ` ${className}` : ''}`}>
      <h4 className={`${styles.editSectionTitle} entity-edit-section-title`}>{title}</h4>
      {children}
    </section>
  )
}

/** Muted caption under an entity-edit control. */
export function EditFormHint({
  children,
  as: Component = 'span',
  id
}: {
  children: ReactNode
  as?: 'span' | 'p'
  id?: string
}): JSX.Element {
  return (
    <Component id={id} className={`${styles.editHint} entity-edit-field-hint`}>
      {children}
    </Component>
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
    <div
      className={`${styles.editField}${span === 2 ? ` ${styles.editFieldFull}` : ''} entity-edit-field${span === 2 ? ' entity-edit-field--full' : ''}`}
    >
      <label htmlFor={htmlFor} className={`${styles.editLabel} entity-edit-label`}>
        <span>{label}</span>
        {labelExtra}
      </label>
      {children}
      {hint ? <EditFormHint>{hint}</EditFormHint> : null}
    </div>
  )
}
