/** One owner for keyboard arbitration. Rendering and image-preview history stay outside. */
export interface InteractionLayer {
  id: string
  parentId?: string
  root(): HTMLElement | null
  anchor?(): HTMLElement | null
  modal?: boolean
  dismiss?(): void
  blockShortcut?(event: KeyboardEvent): boolean
}

const focusableSelector = 'button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex="-1"])'
export const preservedInteractionSurfaceSelector = '[data-interaction-preserve-surface]'

export function createInteractionLayers() {
  const layers: InteractionLayer[] = []
  const isDescendant = (layer: InteractionLayer, parent: InteractionLayer): boolean => {
    const seen = new Set<string>()
    let parentId = layer.parentId
    while (parentId && !seen.has(parentId)) {
      if (parentId === parent.id) return true
      seen.add(parentId)
      parentId = layers.find(item => item.id === parentId)?.parentId
    }
    return false
  }
  const top = (): InteractionLayer | undefined => {
    // Child layout effects can register before parents; ownership beats mount order.
    return [...layers].reverse().find(layer => !layers.some(child => isDescendant(child, layer)))
  }
  const modal = (): InteractionLayer | undefined => {
    const current = top()
    return current && [...layers].reverse().find(layer => layer.modal && (layer === current || isDescendant(current, layer)))
  }
  return {
    register(layer: InteractionLayer): () => void {
      layers.push(layer)
      return () => { const index = layers.indexOf(layer); if (index >= 0) layers.splice(index, 1) }
    },
    isTop(id: string): boolean { return top()?.id === id },
    isActiveModal(id: string): boolean { return modal()?.id === id },
    contains(id: string, target: Node): boolean {
      const owner = layers.find(layer => layer.id === id)
      return Boolean(owner && layers.some(layer => (layer === owner || isDescendant(layer, owner))
        && (layer.root()?.contains(target) || layer.anchor?.()?.contains(target))))
    },
    modalRoots(): HTMLElement[] {
      const owner = modal()
      return owner ? layers.filter(layer => layer === owner || isDescendant(layer, owner)).flatMap(layer => {
        const root = layer.root()
        return root ? [root] : []
      }) : []
    },
    hasModal(): boolean { return layers.some(layer => layer.modal) },
    blocksShortcut(event: KeyboardEvent): boolean {
      const current = top()
      return Boolean(current && layers.some(layer => (layer === current || isDescendant(current, layer))
        && layer.blockShortcut?.(event)))
    },
    focusTargets(): HTMLElement[] {
      const owner = modal()
      const root = owner?.root()
      if (!owner || !root) return []
      const controls = Array.from(root.querySelectorAll<HTMLElement>(focusableSelector))
      const children = layers.filter(layer => isDescendant(layer, owner))
        .sort((a, b) => isDescendant(a, b) ? 1 : isDescendant(b, a) ? -1 : 0)
      for (const child of children) {
        const childRoot = child.root()
        if (!childRoot || root.contains(childRoot)) continue
        const extra = Array.from(childRoot.querySelectorAll<HTMLElement>(focusableSelector)).filter(element => !controls.includes(element))
        const anchorIndex = controls.indexOf(child.anchor?.() as HTMLElement)
        controls.splice(anchorIndex >= 0 ? anchorIndex + 1 : controls.length, 0, ...extra)
      }
      // Global feedback stays reachable without becoming a modal or taking focus.
      for (const surface of document.querySelectorAll<HTMLElement>(preservedInteractionSurfaceSelector)) {
        for (const element of surface.querySelectorAll<HTMLElement>(focusableSelector)) {
          if (!controls.includes(element)) controls.push(element)
        }
      }
      return controls.filter(element => element.tabIndex >= 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]')
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    },
    handleKey(event: KeyboardEvent): void {
      const current = top()
      if (!current || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        current.dismiss?.()
      } else if (event.key === 'Tab') {
        const roots = this.modalRoots()
        if (!roots.length) return
        const controls = this.focusTargets()
        const active = document.activeElement
        const index = controls.indexOf(active as HTMLElement)
        // Explicit traversal includes portaled descendants, not just DOM children.
        event.preventDefault()
        const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        ;(controls[next] ?? roots[0]).focus()
      } else if (this.blocksShortcut(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
  }
}

export const interactionLayers = createInteractionLayers()
