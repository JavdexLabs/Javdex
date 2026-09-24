import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { declarationsFor as readDeclarations } from '../test/cssDeclarations'

const cssPath = 'apps/desktop/src/renderer/src/components/MediaLibraryNav.module.css'

function declarationsFor(selector: string): Map<string, string> {
  return readDeclarations(cssPath, selector)
}

describe('MediaLibraryNav name style', () => {
  it('keeps visible library names on one ellipsized line', () => {
    const declarations = declarationsFor('.name')

    assert.equal(declarations.get('overflow'), 'hidden')
    assert.equal(declarations.get('white-space'), 'nowrap')
    assert.equal(declarations.get('text-overflow'), 'ellipsis')

    const component = readFileSync(
      path.resolve('apps/desktop/src/renderer/src/components/MediaLibraryNav.tsx'),
      'utf8'
    )
    assert.equal(component.match(/className=\{`nav-label \$\{styles\.name\}`\}/g)?.length, 1)
    assert.doesNotMatch(component, /已归档/)
  })

  it('presents media libraries as one compact navigation surface', () => {
    const group = declarationsFor('.group')
    const activeGroup = declarationsFor('.group[data-active="true"]')
    const item = declarationsFor('.list .item')

    assert.equal(group.get('border'), '1px solid var(--border-subtle)')
    assert.equal(group.get('border-radius'), 'var(--radius-md)')
    assert.match(group.get('background') ?? '', /var\(--surface-control\)/)
    assert.equal(activeGroup.get('border-color'), 'var(--border-strong)')
    assert.equal(item.get('height'), 'var(--control-h-md)')
    assert.equal(item.get('padding-inline'), '8px')
  })

  it('keeps global navigation unlabeled in the visible sidebar', () => {
    const layout = readFileSync(
      path.resolve('apps/desktop/src/renderer/src/components/Layout.tsx'),
      'utf8'
    )

    assert.doesNotMatch(layout, />跨媒体库</)
    assert.match(layout, /role="group" aria-label="全局浏览"/)
  })
})
