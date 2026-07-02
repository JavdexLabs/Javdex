import type { ButtonHTMLAttributes } from 'react'
import { ChevronLeft } from 'lucide-react'
import { UI_ICON } from './iconDefaults'

interface BackButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** `detail` — above detail content; `inline` — inside a toolbar row. */
  variant?: 'detail' | 'inline'
}

export default function BackButton({
  variant = 'detail',
  className = '',
  type = 'button',
  ...rest
}: BackButtonProps): JSX.Element {
  return (
    <button
      type={type}
      className={`back-button back-button--${variant}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <span className="back-button__icon" aria-hidden>
        <ChevronLeft {...UI_ICON} />
      </span>
      <span className="back-button__label">返回</span>
    </button>
  )
}
