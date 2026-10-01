import type { ReactNode } from 'react'
import styles from './FormPrimitives.module.css'

/** Shared stack and grid layout for entity edit forms. */
export function EditForm({ children, variant = 'default', className = '' }: {
  children: ReactNode
  variant?: 'default' | 'relaxed' | 'custom'
  className?: string
}): JSX.Element {
  return <div data-edit-form className={[variant === 'custom' ? '' : styles.editForm, className].filter(Boolean).join(' ')}
    data-variant={variant}>{children}</div>
}

export function EditFormFields({ children, variant = 'default', className = '' }: {
  children: ReactNode
  variant?: 'default' | 'relaxed' | 'custom'
  className?: string
}): JSX.Element {
  return <div data-edit-form-fields className={[variant === 'custom' ? '' : styles.editFields, className].filter(Boolean).join(' ')}
    data-variant={variant}>{children}</div>
}

export function EditFormLabelNote({ children, id }: { children: ReactNode; id?: string }): JSX.Element {
  return <span id={id} className={styles.editLabelNote}>{children}</span>
}

export function EditFormCheckRow({ children }: { children: ReactNode }): JSX.Element {
  return <label data-edit-form-check-row className={styles.editCheckRow}>{children}</label>
}

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
    <label className={`${styles.formField}${className ? ` ${className}` : ''}`}>
      <span className={styles.formLabel}>{label}</span>
      {children}
      {hint ? <small className={styles.formHint}>{hint}</small> : null}
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
    <section className={`${styles.formSection}${className ? ` ${className}` : ''}`}>
      <div className={styles.sectionHead}>
        <div>
          <h4 className={styles.sectionTitle}>{title}</h4>
          {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
        </div>
        {actions ? (
          <div className={styles.sectionActions}>{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** Bordered section inside entity edit modals (actress / video metadata). */
export function EditFormSection({
  title,
  hint,
  variant = 'default',
  children
}: {
  title: string
  hint?: ReactNode
  variant?: 'default' | 'media'
  children: ReactNode
}): JSX.Element {
  return (
    <section className={styles.editSection} data-variant={variant}>
      <h4 className={styles.editSectionTitle}>{title}</h4>
      {hint ? (
        <p className={styles.editHint}>{hint}</p>
      ) : null}
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
    <Component id={id} className={styles.editHint}>
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
    <div data-edit-form-field className={`${styles.editField}${span === 2 ? ` ${styles.editFieldFull}` : ''}`}>
      <label htmlFor={htmlFor} className={styles.editLabel}>
        <span>{label}</span>
        {labelExtra}
      </label>
      {children}
      {hint ? <EditFormHint>{hint}</EditFormHint> : null}
    </div>
  )
}
