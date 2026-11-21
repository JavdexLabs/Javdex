import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TestRenderer, { act } from 'react-test-renderer'
import { WorkbenchTabs } from './Workbench'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

describe('shared workbench primitives', () => {
  it('connects tabs to their panels with a single keyboard tab stop', () => {
    const markup = renderToStaticMarkup(
      <WorkbenchTabs
        id="review-tab"
        label="审核工作区"
        value="process"
        items={[
          { id: 'process', label: '处理', panelId: 'review-panel-process' },
          { id: 'source', label: '来源详情', panelId: 'review-panel-source' }
        ]}
        onChange={() => undefined}
      />
    )

    assert.match(markup, /role="tablist" aria-label="审核工作区"/)
    assert.match(
      markup,
      /id="review-tab-process"[^>]*aria-selected="true"[^>]*aria-controls="review-panel-process"[^>]*tabindex="0"/
    )
    assert.match(
      markup,
      /id="review-tab-source"[^>]*aria-selected="false"[^>]*aria-controls="review-panel-source"[^>]*tabindex="-1"/
    )
    assert.doesNotMatch(markup, /workbench-tab|is-active/)
  })

  it('keeps arrow, Home and End navigation skipping disabled tabs and focuses by stable ID', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const focused: string[] = []
    const selected: string[] = []
    let prevented = 0
    let renderer: TestRenderer.ReactTestRenderer | undefined
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      getElementById: (id: string) => ({ focus: () => focused.push(id) })
    } })
    try {
      act(() => {
        renderer = TestRenderer.create(<WorkbenchTabs id="queue-tabs" label="队列" value="a"
          items={[
            { id: 'a', label: '甲', panelId: 'panel-a' },
            { id: 'b', label: '乙', panelId: 'panel-b', disabled: true },
            { id: 'c', label: '丙', panelId: 'panel-c' }
          ]} onChange={(id) => selected.push(id)} />)
      })
      const tabs = renderer!.root.findAllByType('button')
      assert.equal(tabs[1].props.disabled, true)
      for (const [index, key] of [[0, 'ArrowRight'], [2, 'ArrowLeft'], [0, 'End'], [2, 'Home']] as const) {
        act(() => tabs[index].props.onKeyDown({ key, preventDefault: () => prevented++ }))
      }
      assert.deepEqual(selected, ['c', 'a', 'c', 'a'])
      assert.deepEqual(focused, ['queue-tabs-c', 'queue-tabs-a', 'queue-tabs-c', 'queue-tabs-a'])
      assert.equal(prevented, 4)
    } finally {
      renderer?.unmount()
      if (previous) Object.defineProperty(globalThis, 'document', previous)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
})
