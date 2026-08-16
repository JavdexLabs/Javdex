export interface ClassificationPickerState {
  open: boolean
  activeIndex: number
}

export type ClassificationPickerEvent =
  | { type: 'query' }
  | { type: 'move'; delta: number }
  | { type: 'dismiss' }

export function classificationPickerCreateHintVisible(
  query: string,
  options: readonly { mainName: string }[]
): boolean {
  const name = query.trim()
  return name !== '' && options.every((option) => option.mainName !== name)
}

export const CLOSED_CLASSIFICATION_PICKER: ClassificationPickerState = {
  open: false,
  activeIndex: -1
}

export function reduceClassificationPicker(
  state: ClassificationPickerState,
  event: ClassificationPickerEvent,
  optionCount: number
): ClassificationPickerState {
  switch (event.type) {
    case 'query':
      return { open: true, activeIndex: -1 }
    case 'move': {
      if (optionCount === 0) return CLOSED_CLASSIFICATION_PICKER
      const from = state.activeIndex < 0 ? (event.delta > 0 ? -1 : 0) : state.activeIndex
      const next = (((from + event.delta) % optionCount) + optionCount) % optionCount
      return { open: true, activeIndex: next }
    }
    case 'dismiss':
      return CLOSED_CLASSIFICATION_PICKER
  }
}

// Candidates load asynchronously, so visibility is derived at render time instead of
// being stored: the query and the result set can change after the last user event.
export function visibleClassificationPicker(
  state: ClassificationPickerState,
  query: string,
  optionCount: number
): ClassificationPickerState {
  const open = state.open && query.trim() !== '' && optionCount > 0
  return {
    open,
    activeIndex: open && state.activeIndex < optionCount ? state.activeIndex : -1
  }
}
