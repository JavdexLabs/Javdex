import { forwardRef, type TextareaHTMLAttributes } from 'react'
import controlStyles from './TextInput.module.css'
import styles from './TextArea.module.css'

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  density?: 'default' | 'workspace'
}

const TextArea = forwardRef<HTMLTextAreaElement, Props>(function TextArea(
  { density = 'default', className = '', ...props }, ref
) {
  return <textarea {...props} ref={ref}
    className={`${controlStyles.root} ${styles.root}${density === 'workspace' ? ` ${controlStyles.workspace}` : ''}${className ? ` ${className}` : ''}`}
    data-density={density} />
})

export default TextArea
