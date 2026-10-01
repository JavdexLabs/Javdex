/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spatialNavigation } from './navigation'

test('spatial navigation excludes the semantic skip link without reading CSS classes', () => {
  const names = ['document', 'getComputedStyle', 'HTMLInputElement'] as const
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  let focused = '', prevented = 0
  function control(name: string, y: number, skip = false) {
    return { isConnected: true, hasAttribute: (attribute: string) => skip && attribute === 'data-web-skip',
      matches: () => false, closest: () => null, getClientRects: () => [{}],
      getBoundingClientRect: () => ({ x: 0, y, width: 40, height: 20, top: y, bottom: y + 20 }),
      focus: () => { focused = name }, scrollIntoView: () => {},
      get classList() { throw new Error('navigation must not read style classes') } }
  }
  const current = control('current', 0), skip = control('skip', 30, true), next = control('next', 60)
  const body = { matches: () => false }, documentStub = { body, documentElement: {}, activeElement: body as unknown,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [skip, current, next] }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ visibility: 'visible' }) })
  Object.defineProperty(globalThis, 'HTMLInputElement', { configurable: true, value: class {} })
  try {
    const event = { key: 'ArrowDown', preventDefault: () => { prevented++ } } as KeyboardEvent
    spatialNavigation(event)
    assert.equal(focused, 'current', 'initial direction navigation skips the auxiliary link')
    documentStub.activeElement = current
    spatialNavigation(event)
    assert.equal(focused, 'next', 'adjacent navigation also excludes the auxiliary link')
    assert.equal(prevented, 2)
  } finally {
    names.forEach((name, index) => {
      const descriptor = previous[index]
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
})
