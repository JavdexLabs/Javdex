import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(
  selector: string,
  file = 'apps/desktop/src/renderer/src/pages/HomePage.module.css'
): Map<string, string> {
  const source = readFileSync(path.resolve(file), 'utf8')
  const declarations = new Map<string, string>()
  const root = postcss.parse(source)

  root.walkRules((rule) => {
    const selectors = rule.selector.split(',').map((item) => item.trim())
    if (!selectors.includes(selector)) return
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value)
    })
  })

  return declarations
}

describe('HomePage search layout', () => {
  it('reserves shared toolbar-search padding for the icon and keyboard shortcut', () => {
    const search = declarationsFor(
      '.search',
      'apps/desktop/src/renderer/src/components/ListToolbar.module.css'
    )
    const wrappedSearch = declarationsFor(
      '.searchWrap .search',
      'apps/desktop/src/renderer/src/components/ListToolbar.module.css'
    )

    assert.equal(search.get('padding'), '0 14px 0 36px')
    assert.equal(wrappedSearch.get('padding-inline-end'), '66px')
  })

  it('centers the search icon inside the shared input control', () => {
    const declarations = declarationsFor(
      '.search',
      'apps/desktop/src/renderer/src/components/ListToolbar.module.css'
    )

    assert.equal(declarations.get('background-position'), '12px center')
    assert.equal(declarations.get('background-size'), '16px')
  })

  it('keeps the keyboard shortcut on the same vertical center line', () => {
    const declarations = declarationsFor('.shortcut')

    assert.equal(declarations.get('position'), 'absolute')
    assert.equal(declarations.get('top'), '50%')
    assert.equal(declarations.get('transform'), 'translateY(-50%)')
  })
})
