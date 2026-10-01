import { forwardRef, type HTMLAttributes } from 'react'
import styles from './ScrollRegion.module.css'

const ScrollRegion = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function ScrollRegion(
  { className = '', ...props }, ref
) {
  return <div {...props} ref={ref} className={`${styles.root} ${className}`} />
})

export default ScrollRegion
