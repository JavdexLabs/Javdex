import { forwardRef, type HTMLAttributes } from 'react'
import styles from './WebChipRow.module.css'

type Props = HTMLAttributes<HTMLDivElement> & { applied?: boolean }

const WebChipRow = forwardRef<HTMLDivElement, Props>(function WebChipRow({ applied = false, className = '', ...props }, ref) {
  return <div {...props} ref={ref} data-web-filter-chips={applied || undefined}
    className={`${styles.root} ${applied ? styles.applied : ''} ${className}`} />
})

export default WebChipRow
