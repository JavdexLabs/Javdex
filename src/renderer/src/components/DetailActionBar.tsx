import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import IconButton from './IconButton'
import { UI_ICON } from './iconDefaults'

export type DetailBarAction = {
  key: string
  label: string
  icon: ReactNode
  onClick: () => void
  title?: string
  disabled?: boolean
  busy?: boolean
}

type DetailBarMenuCommand = {
  key: string
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  hidden?: boolean
}

type DetailBarMenuSeparator = {
  key: string
  type: 'separator'
  hidden?: boolean
}

export type DetailBarMenuItem = DetailBarMenuCommand | DetailBarMenuSeparator

type DetailPrimaryAction = {
  label: string
  icon?: ReactNode
  onClick: () => void
  disabled?: boolean
  busy?: boolean
}

interface DetailActionBarProps {
  ariaLabel: string
  primary?: DetailPrimaryAction
  actions?: DetailBarAction[]
  menuItems?: DetailBarMenuItem[]
  variant?: 'floating' | 'inline'
  className?: string
}

const isMenuSeparator = (item: DetailBarMenuItem): item is DetailBarMenuSeparator =>
  'type' in item && item.type === 'separator'

export default function DetailActionBar({
  ariaLabel,
  primary,
  actions = [],
  menuItems = [],
  variant = 'floating',
  className = ''
}: DetailActionBarProps): JSX.Element {
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActionsRef = useRef<HTMLDivElement>(null)
  const visibleMenuItems = menuItems.filter((item) => !item.hidden)
  const hasMenu = visibleMenuItems.length > 0

  useEscapeKey(() => setMoreOpen(false), moreOpen)

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!moreActionsRef.current?.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [moreOpen])

  return (
    <div
      className={`detail-actions detail-actions--${variant}${className ? ` ${className}` : ''}`}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {primary ? (
        <button
          type="button"
          className="btn btn-primary detail-play-btn"
          disabled={primary.disabled || primary.busy}
          aria-busy={primary.busy || undefined}
          onClick={primary.onClick}
        >
          {primary.icon}
          <span>{primary.label}</span>
        </button>
      ) : null}

      {actions.length > 0 ? (
        <div className="detail-action-group detail-action-group--icons" role="group" aria-label={ariaLabel}>
          {actions.map((action) => (
            <IconButton
              key={action.key}
              className="detail-icon-action"
              icon={action.icon}
              label={action.label}
              title={action.title ?? action.label}
              disabled={action.disabled || action.busy}
              aria-busy={action.busy || undefined}
              onClick={action.onClick}
            />
          ))}
        </div>
      ) : null}

      {hasMenu ? (
        <div className="detail-more-actions" ref={moreActionsRef}>
          <IconButton
            className="detail-icon-action"
            icon={<Ellipsis {...UI_ICON} />}
            label={'\u66f4\u591a'}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          />
          {moreOpen && (
            <div className="detail-more-menu" role="menu">
              {visibleMenuItems.map((item) => {
                if (isMenuSeparator(item)) {
                  return <div key={item.key} className="detail-menu-separator" />
                }
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`detail-menu-item${item.danger ? ' detail-menu-item--danger' : ''}`}
                    role="menuitem"
                    disabled={item.disabled}
                    onClick={() => {
                      setMoreOpen(false)
                      item.onClick()
                    }}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
