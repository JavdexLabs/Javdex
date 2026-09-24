import { act, type ReactTestRenderer } from 'react-test-renderer'
import ContinuousGrid, { clearContinuousScrollMemory } from '../components/ContinuousGrid'

/** Minimal layout owner for component tests; browser harness verifies real geometry. */
export function continuousViewport() {
  clearContinuousScrollMemory()
  const listeners = new Set<() => void>()
  const owner = {
    scrollTop: 0, clientWidth: 400, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0, width: 400, height: 400 }),
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    scrollTo: ({ top }: { top: number }) => { owner.scrollTop = top }
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ overflowY: 'auto' }) })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (fn: () => void) => { fn(); return 0 } })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })
  return {
    owner,
    createNodeMock: (element: { props: Record<string, unknown> }) => ['group','listbox'].includes(String(element.props.role)) && element.props['aria-busy'] !== undefined
      ? { clientWidth: 400, parentElement: owner, getBoundingClientRect: () => ({ top: -owner.scrollTop }), querySelector: () => null }
      : /viewport|fill/.test(String(element.props.className)) ? owner : null,
    async scroll(renderer: ReactTestRenderer, index: number) {
      const grid = renderer.root.findByType(ContinuousGrid)
      const gap = grid.props.gap ?? (grid.props.minWidth ? 12 : 4)
      const columns = grid.props.minWidth ? Math.max(1, Math.floor((400 + gap) / (grid.props.minWidth + gap))) : 1
      const width = (400 - (columns - 1) * gap) / columns
      const row = (typeof grid.props.itemHeight === 'function' ? grid.props.itemHeight(width) : grid.props.itemHeight ?? 64) + gap
      await act(async () => {
        owner.scrollTop = Math.floor(index / columns) * row
        for (const listener of listeners) listener()
      })
    }
  }
}
