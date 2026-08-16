import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ClassificationPicker, { type ClassificationPickerOption } from './ClassificationPicker'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const options: ClassificationPickerOption[] = [
  { id: 11, mainName: 'Collection', description: '#11 · Studio A · 3 部' },
  { id: 12, mainName: 'Collection Deluxe', description: '#12 · Studio B · 1 部' }
]

let renderer: TestRenderer.ReactTestRenderer | null = null
let selected: ClassificationPickerOption | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
  selected = null
})

function renderPicker(value = 'Collection'): void {
  act(() => {
    renderer = TestRenderer.create(
      <ClassificationPicker
        id="video-edit-series"
        value={value}
        options={options}
        selectedId={null}
        listLabel="系列候选"
        createHint="保留当前输入可新建未归属系列"
        onValueChange={() => undefined}
        onSelect={(option) => {
          selected = option
        }}
      />
    )
  })
}

function input(): TestRenderer.ReactTestInstance {
  const found = renderer?.root.findByType('input')
  assert.ok(found)
  return found
}

function listbox(): TestRenderer.ReactTestInstance | null {
  return renderer?.root.findAllByProps({ role: 'listbox' })[0] ?? null
}

function keyDown(key: string): { defaultPrevented: boolean; nativePropagationStopped: boolean } {
  const event = {
    key,
    defaultPrevented: false,
    nativePropagationStopped: false,
    preventDefault(): void {
      event.defaultPrevented = true
    },
    nativeEvent: {
      stopPropagation(): void {
        event.nativePropagationStopped = true
      }
    }
  }
  act(() => {
    input().props.onKeyDown(event)
  })
  return event
}

describe('classification picker', () => {
  it('keeps candidates hidden until the field is used', () => {
    renderPicker()

    assert.equal(listbox(), null)
    assert.equal(input().props['aria-expanded'], false)
  })

  it('shows candidates once the user types', () => {
    renderPicker()

    act(() => {
      input().props.onChange({ target: { value: 'Coll' } })
    })

    assert.ok(listbox())
    assert.equal(input().props['aria-expanded'], true)
  })

  it('walks candidates with the arrow keys and commits with Enter', () => {
    renderPicker()

    const down = keyDown('ArrowDown')
    assert.ok(down.defaultPrevented)
    assert.equal(input().props['aria-activedescendant'], 'video-edit-series-option-11')

    keyDown('ArrowDown')
    assert.equal(input().props['aria-activedescendant'], 'video-edit-series-option-12')

    const enter = keyDown('Enter')
    assert.ok(enter.defaultPrevented)
    assert.deepEqual(selected, options[1])
    assert.equal(listbox(), null)
  })

  it('shows candidates once the field is focused', () => {
    renderPicker()

    act(() => {
      input().props.onFocus()
    })

    assert.ok(listbox())
    assert.equal(input().props['aria-expanded'], true)
  })

  it('does not commit a candidate with Enter until one is active', () => {
    renderPicker()

    act(() => {
      input().props.onChange({ target: { value: 'Coll' } })
    })
    const enter = keyDown('Enter')

    assert.equal(enter.defaultPrevented, false)
    assert.equal(selected, null)
  })

  it('closes candidates on Escape without letting the dialog see the key', () => {
    renderPicker()
    keyDown('ArrowDown')

    const escape = keyDown('Escape')

    assert.equal(listbox(), null)
    assert.ok(escape.nativePropagationStopped)

    const closedEscape = keyDown('Escape')
    assert.equal(closedEscape.nativePropagationStopped, false)
  })

  it('closes candidates when focus leaves the field', () => {
    renderPicker()
    keyDown('ArrowDown')

    act(() => {
      input().props.onBlur()
    })

    assert.equal(listbox(), null)
  })

  it('keeps candidates open when the pointer is in the list', () => {
    renderPicker()
    keyDown('ArrowDown')

    act(() => {
      listbox()?.props.onMouseDown({ button: 0 })
      input().props.onBlur()
    })

    assert.ok(listbox())
  })

  it('closes candidates after picking one with the pointer', () => {
    renderPicker()
    keyDown('ArrowDown')

    act(() => {
      renderer?.root.findAllByProps({ role: 'option' })[1].props.onClick()
    })

    assert.deepEqual(selected, options[1])
    assert.equal(listbox(), null)
  })
})
