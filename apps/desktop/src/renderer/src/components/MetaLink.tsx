import type { ButtonHTMLAttributes } from 'react'

/** Inline metadata value that navigates on click (facet, prefix filter, etc.). */
export default function MetaLink({
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type={type}
      className={`meta-val meta-link${className ? ` ${className}` : ''}`}
      {...rest}
    />
  )
}
