import { forwardRef, type HTMLAttributes } from 'react'
import styles from './VirtualGridViewport.module.css'

/** Keep react-window's computed dimensions, but own the scroll policy locally. */
const VirtualGridViewport = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function VirtualGridViewport({ style, className = '', ...props }, ref) {
    return <div {...props} ref={ref} className={`${styles.root} ${className}`}
      style={{ ...style, overflow: undefined }} />
  }
)

export default VirtualGridViewport
