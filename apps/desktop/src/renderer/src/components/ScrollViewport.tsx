import { forwardRef, type HTMLAttributes } from 'react'
import styles from './ScrollViewport.module.css'

interface Props extends HTMLAttributes<HTMLDivElement> {
  variant: 'scroll' | 'fill'
}

const ScrollViewport = forwardRef<HTMLDivElement, Props>(function ScrollViewport(
  { variant, className = '', ...props }, ref
) {
  return <div {...props} ref={ref} data-scroll-viewport={variant} className={`${styles.root} ${styles[variant]} ${className}`} />
})

export default ScrollViewport
