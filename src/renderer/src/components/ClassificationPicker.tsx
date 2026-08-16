import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  CLOSED_CLASSIFICATION_PICKER,
  classificationPickerCreateHintVisible,
  reduceClassificationPicker,
  visibleClassificationPicker,
  type ClassificationPickerEvent
} from './classificationPickerState'
import FloatingLayer from './FloatingLayer'
import styles from './ClassificationPicker.module.css'

export interface ClassificationPickerOption {
  id: number
  mainName: string
  description: string
}

interface Props {
  id: string
  value: string
  options: readonly ClassificationPickerOption[]
  selectedId: number | null
  listLabel: string
  createHint: string
  onValueChange: (value: string) => void
  onSelect: (option: ClassificationPickerOption) => void
}

function canPortal(): boolean {
  return typeof document !== 'undefined' && typeof document.body?.appendChild === 'function'
}

export default function ClassificationPicker({
  id,
  value,
  options,
  selectedId,
  listLabel,
  createHint,
  onValueChange,
  onSelect
}: Props): JSX.Element {
  const [state, setState] = useState(CLOSED_CLASSIFICATION_PICKER)
  const [listWidth, setListWidth] = useState<number>()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const pointerInListRef = useRef(false)
  const view = visibleClassificationPicker(state, value, options.length)
  const listId = `${id}-options`
  const optionId = (option: ClassificationPickerOption): string => `${id}-option-${option.id}`

  useLayoutEffect(() => {
    if (!view.open) return
    const width = inputRef.current?.getBoundingClientRect().width
    if (width) setListWidth(width)
  }, [view.open])

  useLayoutEffect(() => {
    activeOptionRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [view.activeIndex])

  const dispatch = (event: ClassificationPickerEvent): void => {
    setState((previous) => reduceClassificationPicker(previous, event, options.length))
  }

  const dismiss = useCallback(() => {
    setState(CLOSED_CLASSIFICATION_PICKER)
  }, [])

  const select = (option: ClassificationPickerOption): void => {
    setState(CLOSED_CLASSIFICATION_PICKER)
    onSelect(option)
  }

  const markPointerInList = (): void => {
    pointerInListRef.current = true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      dispatch({ type: 'move', delta: event.key === 'ArrowDown' ? 1 : -1 })
      return
    }
    if (event.key === 'Enter' && view.activeIndex >= 0) {
      event.preventDefault()
      select(options[view.activeIndex])
      return
    }
    // Closing the candidate list must not also close the surrounding dialog, which
    // listens for Escape on the window.
    if (event.key === 'Escape' && view.open) {
      event.preventDefault()
      event.nativeEvent.stopPropagation()
      setState(CLOSED_CLASSIFICATION_PICKER)
    }
  }

  const listbox = view.open ? (
    <div
      id={listId}
      className={styles.options}
      role="listbox"
      aria-label={listLabel}
      onMouseDown={markPointerInList}
    >
      {options.map((option, index) => (
        <button
          key={option.id}
          ref={index === view.activeIndex ? activeOptionRef : undefined}
          id={optionId(option)}
          type="button"
          tabIndex={-1}
          role="option"
          className={styles.option}
          aria-selected={selectedId === option.id}
          data-active={index === view.activeIndex || undefined}
          onClick={() => select(option)}
        >
          <span className={styles.optionName}>{option.mainName}</span>
          <small className={styles.optionMeta}>{option.description}</small>
        </button>
      ))}
      {classificationPickerCreateHintVisible(value, options) ? (
        <div className={styles.create}>{createHint}</div>
      ) : null}
    </div>
  ) : null

  return (
    <div className={styles.picker}>
      <input
        ref={inputRef}
        id={id}
        className="text-input"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={view.open}
        aria-controls={view.open ? listId : undefined}
        aria-activedescendant={
          view.activeIndex >= 0 ? optionId(options[view.activeIndex]) : undefined
        }
        autoComplete="off"
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          dispatch({ type: 'query' })
        }}
        onFocus={() => dispatch({ type: 'query' })}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (pointerInListRef.current) {
            pointerInListRef.current = false
            return
          }
          dispatch({ type: 'dismiss' })
        }}
      />
      {canPortal() ? (
        <FloatingLayer
          open={view.open}
          anchorRef={inputRef}
          side="bottom"
          align="start"
          offset={4}
          className={styles.layer}
          style={listWidth ? { width: listWidth } : undefined}
          onClose={dismiss}
        >
          {listbox}
        </FloatingLayer>
      ) : (
        listbox
      )}
    </div>
  )
}
