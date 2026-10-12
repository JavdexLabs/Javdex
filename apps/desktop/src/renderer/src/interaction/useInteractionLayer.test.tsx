import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { interactionLayers, preservedInteractionSurfaceSelector } from './interactionLayers'
import { useInteractionLayer } from './useInteractionLayer'

class ElementFixture {
  parent: ElementFixture | null = null
  children: ElementFixture[] = []
  style = { overflow: 'auto' }
  inert = false
  hidden = false
  disabled = false
  preserve = false
  tabIndex = -1
  isConnected = true
  constructor(readonly id: string, tabIndex = -1) { this.tabIndex = tabIndex }
  append(...children: ElementFixture[]): void { for (const child of children) { child.parent = this; this.children.push(child) } }
  contains(element: ElementFixture): boolean { return element === this || this.children.some(child => child.contains(element)) }
  all(): ElementFixture[] { return this.children.flatMap(child => [child, ...child.all()]) }
  querySelectorAll(selector: string): ElementFixture[] {
    return this.all().filter(element => selector === preservedInteractionSurfaceSelector ? element.preserve : element.tabIndex >= 0)
  }
  closest(selector: string): ElementFixture | null {
    return this.inert || selector.includes('[hidden]') && this.hidden ? this : this.parent?.closest(selector) ?? null
  }
  matches(): boolean { return this.disabled }
  getClientRects(): number[] { return this.hidden ? [] : [1] }
  focus(): void { dom.activeElement = this }
}
let dom: { body: ElementFixture; activeElement: ElementFixture | null; querySelectorAll(selector: string): ElementFixture[] }
class ObserverFixture {
  static active: ObserverFixture | null = null
  options?: MutationObserverInit
  constructor(private readonly callback: MutationCallback) { ObserverFixture.active = this }
  observe(_element: unknown, options: MutationObserverInit): void { this.options = options }
  disconnect(): void { if (ObserverFixture.active === this) ObserverFixture.active = null }
  changed(): void {
    this.callback([{ type: 'attributes', attributeName: 'data-interaction-preserve-surface' } as MutationRecord], this as unknown as MutationObserver)
  }
}

test('modal inert handling preserves explicit feedback and its Tab controls without stealing ownership or focus', () => {
  const body = new ElementFixture('body'), wrapper = new ElementFixture('wrapper'), modal = new ElementFixture('playback')
  const background = new ElementFixture('background', 0), modalControl = new ElementFixture('playback-control', 0)
  const toastWrapper = new ElementFixture('toast-wrapper'), toast = new ElementFixture('toast')
  const details = new ElementFixture('toast-details', 0), close = new ElementFixture('toast-close', 0)
  const previouslyInert = new ElementFixture('previously-inert'); previouslyInert.inert = true
  body.append(wrapper, previouslyInert); wrapper.append(background, modal, toastWrapper)
  modal.append(modalControl); toastWrapper.append(toast); toast.append(details, close)
  dom = { body, activeElement: null, querySelectorAll: selector => body.querySelectorAll(selector) }
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: ElementFixture })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
  Object.defineProperty(globalThis, 'MutationObserver', { configurable: true, value: ObserverFixture })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible' }) })
  let layer: ReturnType<typeof useInteractionLayer> | undefined
  function Harness() {
    const root = useRef(modal as unknown as HTMLElement)
    layer = useInteractionLayer({ rootRef: root, modal: true })
    return null
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<Harness />) })
  try {
    assert.equal(background.inert, true)
    assert.equal(toast.closest('[inert]'), toastWrapper)
    assert.equal(body.style.overflow, 'hidden')
    modalControl.focus()
    toast.preserve = true
    act(() => ObserverFixture.active!.changed())
    assert.equal(toast.closest('[inert]'), null, 'preserved feedback and its ancestors must not block pointer input')
    assert.equal(background.inert, true, 'preservation does not release unrelated background controls')
    assert.equal(previouslyInert.inert, true)
    assert.equal(dom.activeElement, modalControl, 'feedback arrival leaves keyboard focus in playback')
    assert.equal(layer!.isTop(), true, 'feedback does not register a new layer')
    assert.deepEqual(interactionLayers.focusTargets().map(element => element.id), ['playback-control', 'toast-details', 'toast-close'])
    for (const expected of [details, close, modalControl]) {
      const key = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab' })
      window.dispatchEvent(key)
      assert.equal(key.defaultPrevented, true)
      assert.equal(dom.activeElement, expected)
    }
    toast.preserve = false
    act(() => ObserverFixture.active!.changed())
    assert.equal(toast.closest('[inert]'), toastWrapper, 'dismissed feedback rejoins the inert background')
    assert.deepEqual(interactionLayers.focusTargets().map(element => element.id), ['playback-control'])
    assert.deepEqual(ObserverFixture.active!.options?.attributeFilter, ['data-interaction-preserve-surface'])
  } finally { act(() => renderer.unmount()) }
  assert.equal(background.inert, false)
  assert.equal(toastWrapper.inert, false)
  assert.equal(previouslyInert.inert, true)
  assert.equal(body.style.overflow, 'auto')
  assert.equal(interactionLayers.hasModal(), false)
})
