import type { ButtonHTMLAttributes } from 'react'
import styles from './MetaLink.module.css'

/** Inline metadata value that navigates on click (facet, prefix filter, etc.). */
export default function MetaLink({
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type={type}
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}
