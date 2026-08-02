import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  WorkbenchMain,
  WorkbenchRail,
  WorkbenchShell,
  WorkbenchTabs,
  WorkbenchToolbar
} from './Workbench'

describe('shared workbench primitives', () => {
  it('composes feature classes without replacing the neutral structure', () => {
    const markup = renderToStaticMarkup(
      <WorkbenchShell className="feature-shell">
        <WorkbenchToolbar className="feature-toolbar">Toolbar</WorkbenchToolbar>
        <WorkbenchMain className="feature-main">
          <WorkbenchRail className="feature-rail">Rail</WorkbenchRail>
        </WorkbenchMain>
      </WorkbenchShell>
    )

    assert.match(markup, /class="workbench-shell feature-shell"/)
    assert.match(markup, /class="workbench-toolbar feature-toolbar"/)
    assert.match(markup, /class="workbench-main feature-main"/)
    assert.match(markup, /class="workbench-rail feature-rail"/)
  })

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
  })
})
