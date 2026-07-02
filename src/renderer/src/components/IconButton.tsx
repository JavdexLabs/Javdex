import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  /** Accessible name; also used as title when title is omitted. */
  label: string
  title?: string
}

/** Square control with a centered SVG icon glyph. */
export default function IconButton({
  icon,
  label,
  title,
  className = '',
  type = 'button',
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      type={type}
      className={`icon-btn${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <span className="icon-btn__glyph">{icon}</span>
    </button>
  )
}
