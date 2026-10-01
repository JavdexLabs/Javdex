import { forwardRef, type HTMLAttributes } from 'react'
import styles from './WebText.module.css'

type Props = HTMLAttributes<HTMLParagraphElement> & { tone: 'muted' | 'danger' | 'eyebrow' }

export default forwardRef<HTMLParagraphElement, Props>(function WebText({ tone, className = '', ...props }, ref) {
  return <p {...props} ref={ref} className={`${styles[tone]} ${className}`} />
})
