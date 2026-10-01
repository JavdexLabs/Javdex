import { forwardRef, type InputHTMLAttributes } from 'react'
import styles from './TextInput.module.css'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: 'default' | 'filter'
  density?: 'default' | 'workspace'
}

const TextInput = forwardRef<HTMLInputElement, Props>(function TextInput(
  { variant = 'default', density = 'default', className = '', type = 'text', ...props }, ref
) {
  return <input {...props} ref={ref} type={type}
    className={`${styles.root}${density === 'workspace' ? ` ${styles.workspace}` : ''}${className ? ` ${className}` : ''}`}
    data-variant={variant} data-density={density} />
})

export default TextInput
