import { forwardRef, type InputHTMLAttributes } from 'react'
import styles from './SearchInput.module.css'

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: 'default' | 'toolbar' | 'compact'
  fullWidth?: boolean
  withAdornment?: boolean
}

const SearchInput = forwardRef<HTMLInputElement, Props>(function SearchInput(
  { variant = 'default', fullWidth = false, withAdornment = false, className = '', ...props }, ref
) {
  return <input {...props} ref={ref} type="search" className={`${styles.root} ${className}`}
    data-variant={variant} data-full-width={fullWidth || undefined} data-adornment={withAdornment || undefined} />
})

export default SearchInput
