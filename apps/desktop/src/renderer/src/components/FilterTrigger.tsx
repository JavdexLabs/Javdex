import { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import Button from './Button'
import { UI_ICON_SM } from './iconDefaults'
import styles from './FilterTrigger.module.css'

const FilterTrigger = forwardRef<HTMLButtonElement, {
  open: boolean
  active: boolean
  onClick: () => void
}>(function FilterTrigger({ open, active, onClick }, ref) {
  return <Button ref={ref} type="button" size="sm" className={styles.root}
    data-active={active || undefined} aria-expanded={open} aria-haspopup="dialog" onClick={onClick}>
    <span className={styles.label}>筛选</span>
    <ChevronDown {...UI_ICON_SM} className={styles.chevron} aria-hidden />
  </Button>
})

export default FilterTrigger
