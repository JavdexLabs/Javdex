import { forwardRef, type InputHTMLAttributes } from 'react'
import styles from './WebTextInput.module.css'

export default forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  appearance?: 'default' | 'login'
}>(function WebTextInput({ appearance = 'default', className = '', ...props }, ref) {
  return <input {...props} ref={ref} data-appearance={appearance} className={`${styles.input} ${className}`} />
})
