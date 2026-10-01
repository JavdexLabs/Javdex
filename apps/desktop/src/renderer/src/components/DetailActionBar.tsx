import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import DetailIconButton from './DetailIconButton'
import { DetailMenuAnchor, DetailMenuItem, DetailMenuPanel, DetailMenuSeparator } from './DetailMenu'
import { UI_ICON } from './iconDefaults'
import Button from './Button'
import styles from './DetailActionBar.module.css'

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
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      data-variant={variant}
      role="toolbar"
      aria-label={ariaLabel}
    >
      {primary ? (
        <Button
          type="button"
          variant="primary"
          className={styles.primary}
          disabled={primary.disabled || primary.busy}
          aria-busy={primary.busy || undefined}
          onClick={primary.onClick}
        >
          {primary.icon}
          <span>{primary.label}</span>
        </Button>
      ) : null}

      {actions.length > 0 ? (
        <div className={styles.actionGroup} role="group" aria-label={ariaLabel}>
          {actions.map((action) => (
            <DetailIconButton
              key={action.key}
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
        <DetailMenuAnchor ref={moreActionsRef}>
          <DetailIconButton
            icon={<Ellipsis {...UI_ICON} />}
            label={'\u66f4\u591a'}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          />
          {moreOpen && (
            <DetailMenuPanel>
              {visibleMenuItems.map((item) => {
                if (isMenuSeparator(item)) {
                  return <DetailMenuSeparator key={item.key} />
                }
                return (
                  <DetailMenuItem
                    key={item.key}
                    danger={item.danger}
                    disabled={item.disabled}
                    onClick={() => {
                      setMoreOpen(false)
                      item.onClick()
                    }}
                  >
                    {item.label}
                  </DetailMenuItem>
                )
              })}
            </DetailMenuPanel>
          )}
        </DetailMenuAnchor>
      ) : null}
    </div>
  )
}
