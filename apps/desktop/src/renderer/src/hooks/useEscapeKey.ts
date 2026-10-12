import { useInteractionLayer } from '../interaction/useInteractionLayer'

export function useEscapeKey(onEscape: () => void, enabled = true): void {
  useInteractionLayer({ enabled, onDismiss: onEscape })
}
