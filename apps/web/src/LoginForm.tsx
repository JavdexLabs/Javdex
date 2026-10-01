import type { LabelHTMLAttributes, HTMLAttributes, ChangeEventHandler, ReactNode } from 'react'
import Checkbox from '../../../packages/ui/src/Checkbox'
import { WebButton } from './WebButton'
import type { ButtonHTMLAttributes } from 'react'
import styles from './LoginForm.module.css'

export function LoginField({ className = '', ...props }: LabelHTMLAttributes<HTMLLabelElement>): JSX.Element {
  return <label {...props} className={`${styles.field} ${className}`} />
}
export function RememberDevice({ checked, onChange, children }: {
  checked: boolean; onChange: ChangeEventHandler<HTMLInputElement>; children: ReactNode
}): JSX.Element {
  return <label className={styles.remember}><Checkbox checked={checked} onChange={onChange} />{children}</label>
}
export function LoginCopy({ tone = 'muted', className = '', ...props }: HTMLAttributes<HTMLParagraphElement> & {
  tone?: 'muted' | 'danger'
}): JSX.Element {
  return <p {...props} className={`${tone === 'danger' ? styles.error : styles.help} ${className}`} />
}

export function LoginSubmitButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return <WebButton {...props} variant="primary" className={`${styles.submit} ${className}`} />
}
