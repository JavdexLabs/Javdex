import type { ButtonHTMLAttributes, ComponentProps, HTMLAttributes, ReactNode } from 'react'
import EmptyState from './EmptyState'
import styles from './ClassificationChoices.module.css'

export function ClassificationChoiceList({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} className={`${styles.list}${className ? ` ${className}` : ''}`} />
}

export function ClassificationChoiceEmpty(props: Omit<ComponentProps<typeof EmptyState>, 'className' | 'variant'>): JSX.Element {
  return <EmptyState {...props} variant="modal" className={styles.empty} />
}

interface ChoiceProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'role' | 'aria-checked' | 'aria-selected' | 'name'> {
  role: 'option' | 'radio'
  selected: boolean
  name: ReactNode
  description: ReactNode
  extraDescription?: ReactNode
  trailing?: ReactNode
}

export function ClassificationChoiceRow({
  role, selected, name, description, extraDescription, trailing, className = '', ...props
}: ChoiceProps): JSX.Element {
  return (
    <button
      {...props}
      type="button"
      role={role}
      aria-selected={role === 'option' ? selected : undefined}
      aria-checked={role === 'radio' ? selected : undefined}
      className={`${styles.row}${className ? ` ${className}` : ''}`}
    >
      <span className={styles.radio} aria-hidden />
      <span className={styles.copy}>
        <strong>{name}</strong>
        <small>{description}</small>
        {extraDescription ? <small>{extraDescription}</small> : null}
      </span>
      {trailing != null ? <span>{trailing}</span> : null}
    </button>
  )
}
