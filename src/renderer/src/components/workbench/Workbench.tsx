import { type HTMLAttributes, type ReactNode } from 'react'

function classNames(base: string, className?: string): string {
  return className ? `${base} ${className}` : base
}

export function WorkbenchShell({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={classNames('workbench-shell', className)} {...props} />
}

export function WorkbenchToolbar({
  className,
  ...props
}: HTMLAttributes<HTMLElement>): JSX.Element {
  return <header className={classNames('workbench-toolbar', className)} {...props} />
}

export function WorkbenchMain({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={classNames('workbench-main', className)} {...props} />
}

export function WorkbenchRail({
  className,
  ...props
}: HTMLAttributes<HTMLElement>): JSX.Element {
  return <aside className={classNames('workbench-rail', className)} {...props} />
}

export function WorkbenchRailHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={classNames('workbench-rail-header', className)} {...props} />
}

export function WorkbenchStatusPill({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: 'waiting' | 'ok'
}): JSX.Element {
  return (
    <span
      className={classNames('workbench-status-pill', className)}
      data-tone={tone}
      {...props}
    />
  )
}

export interface WorkbenchTabItem<T extends string> {
  id: T
  label: ReactNode
  panelId: string
  disabled?: boolean
}

export function WorkbenchTabs<T extends string>({
  id,
  label,
  value,
  items,
  className,
  onChange
}: {
  id: string
  label: string
  value: T
  items: WorkbenchTabItem<T>[]
  className?: string
  onChange: (value: T) => void
}): JSX.Element {
  const enabledItems = items.filter((item) => !item.disabled)
  const moveFocus = (item: WorkbenchTabItem<T>): void => {
    onChange(item.id)
    document.getElementById(`${id}-${item.id}`)?.focus()
  }

  return (
    <div
      id={id}
      className={classNames('workbench-tabs', className)}
      role="tablist"
      aria-label={label}
    >
      {items.map((item) => {
        const tabId = `${id}-${item.id}`
        return (
          <button
            key={item.id}
            id={tabId}
            type="button"
            role="tab"
            aria-selected={value === item.id}
            aria-controls={item.panelId}
            tabIndex={value === item.id ? 0 : -1}
            disabled={item.disabled}
            className={`workbench-tab${value === item.id ? ' is-active' : ''}`}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              const currentIndex = enabledItems.findIndex((candidate) => candidate.id === item.id)
              if (currentIndex < 0 || enabledItems.length < 2) return
              let nextIndex: number | null = null
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                nextIndex = (currentIndex + 1) % enabledItems.length
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length
              } else if (event.key === 'Home') {
                nextIndex = 0
              } else if (event.key === 'End') {
                nextIndex = enabledItems.length - 1
              }
              if (nextIndex === null) return
              event.preventDefault()
              moveFocus(enabledItems[nextIndex])
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
