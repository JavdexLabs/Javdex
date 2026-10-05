import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react'
import { createPortal } from 'react-dom'
import styles from './SelectControl.module.css'
import { useInteractionLayer } from '../interaction/useInteractionLayer'

interface SelectOption {
  value: string
  label: string
  disabled?: boolean
  hidden?: boolean
}

interface OptionProps {
  value?: string | number
  disabled?: boolean
  hidden?: boolean
  children?: ReactNode
}

type SelectControlProps = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  | 'children'
  | 'defaultValue'
  | 'multiple'
  | 'onBlur'
  | 'onChange'
  | 'onClick'
  | 'onFocus'
  | 'onKeyDown'
  | 'size'
  | 'value'
> & {
  children: ReactNode
  value: string | number
  displayLabel?: string
  variant?: 'default' | 'filter'
  buttonClassName?: string
  onChange?: (event: ChangeEvent<HTMLSelectElement>) => void
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return ''
}

function collectOptions(children: ReactNode, output: SelectOption[] = []): SelectOption[] {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const element = child as ReactElement<OptionProps>
    if (element.type === Fragment) {
      collectOptions(element.props.children, output)
      return
    }
    if (element.type !== 'option') return
    const label = nodeText(element.props.children)
    output.push({
      value: String(element.props.value ?? label),
      label,
      disabled: element.props.disabled,
      hidden: element.props.hidden
    })
  })
  return output
}

export default function SelectControl({
  children,
  className = '',
  autoFocus,
  disabled,
  id,
  name,
  onChange,
  title,
  value,
  displayLabel,
  variant = 'default',
  buttonClassName,
  'aria-label': ariaLabel
}: SelectControlProps): JSX.Element {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const listboxId = useId()
  const valueText = String(value)
  const options = useMemo(() => collectOptions(children), [children])
  const visibleOptions = options.filter((option) => !option.hidden)
  const selectedOption = options.find((option) => option.value === valueText && !option.hidden)
  const selectedIndex = Math.max(
    0,
    visibleOptions.findIndex((option) => option.value === valueText)
  )
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const [menuPlacement, setMenuPlacement] = useState<'bottom' | 'top'>('bottom')
  const layer = useInteractionLayer({ enabled: open, rootRef: menuRef, anchorRef: buttonRef, onDismiss: () => setOpen(false) })

  useEffect(() => {
    setActiveIndex(selectedIndex)
  }, [selectedIndex])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!layer.isTop() || layer.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [layer, open])

  useLayoutEffect(() => {
    if (!open) return

    const updateMenuPosition = (): void => {
      const button = buttonRef.current
      if (!button) return

      const rect = button.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const edgeGap = 8
      const menuGap = 5
      const menuWidth = Math.max(rect.width, 132)
      const left = Math.min(
        Math.max(edgeGap, rect.left),
        Math.max(edgeGap, viewportWidth - menuWidth - edgeGap)
      )
      const spaceBelow = viewportHeight - rect.bottom - menuGap - edgeGap
      const spaceAbove = rect.top - menuGap - edgeGap
      const desiredHeight = Math.min(260, Math.max(96, visibleOptions.length * 32 + 12))
      const openUp = spaceBelow < Math.min(180, desiredHeight) && spaceAbove > spaceBelow
      const maxHeight = Math.max(96, Math.min(260, openUp ? spaceAbove : spaceBelow))

      setMenuPlacement(openUp ? 'top' : 'bottom')
      setMenuStyle(
        openUp
          ? {
              left,
              width: menuWidth,
              maxHeight,
              bottom: viewportHeight - rect.top + menuGap
            }
          : {
              left,
              width: menuWidth,
              maxHeight,
              top: rect.bottom + menuGap
            }
      )
    }

    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [open, visibleOptions.length])

  const selectValue = (nextValue: string): void => {
    const option = visibleOptions.find((item) => item.value === nextValue)
    if (!option || option.disabled) return
    onChange?.({
      target: { value: nextValue },
      currentTarget: { value: nextValue }
    } as ChangeEvent<HTMLSelectElement>)
    setOpen(false)
    window.setTimeout(() => buttonRef.current?.focus(), 0)
  }

  const moveActive = (delta: number): void => {
    const enabled = visibleOptions
      .map((option, index) => ({ option, index }))
      .filter((item) => !item.option.disabled)
    if (enabled.length === 0) return
    const currentEnabledIndex = enabled.findIndex((item) => item.index === activeIndex)
    const nextEnabledIndex =
      currentEnabledIndex < 0
        ? 0
        : (currentEnabledIndex + delta + enabled.length) % enabled.length
    setActiveIndex(enabled[nextEnabledIndex].index)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      moveActive(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      selectValue(visibleOptions[activeIndex]?.value ?? valueText)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      data-open={open || undefined}
      data-variant={variant}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.button}${buttonClassName ? ` ${buttonClassName}` : ''}`}
        id={id}
        name={name}
        autoFocus={autoFocus}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => setOpen((next) => !next)}
        onKeyDown={onKeyDown}
      >
        <span className={styles.value}>{displayLabel ?? selectedOption?.label ?? visibleOptions[0]?.label ?? ''}</span>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              className={styles.menu}
              data-select-control-menu="true"
              data-native-playback-occluder="true"
              data-placement={menuPlacement}
              role="listbox"
              tabIndex={-1}
              style={{ ...menuStyle, ...layer.style }}
            >
              {visibleOptions.map((option, index) => {
                const selected = option.value === valueText
                return (
                  <button
                    key={`${option.value}:${index}`}
                    type="button"
                    className={styles.option}
                    data-active={index === activeIndex || undefined}
                    disabled={option.disabled}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectValue(option.value)}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
