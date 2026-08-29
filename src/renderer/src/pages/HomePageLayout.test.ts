import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(
  selector: string,
  file = 'src/renderer/src/pages/HomePage.module.css'
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
  it('reserves shared-control padding for the icon and keyboard shortcut', () => {
    const searchInput = declarationsFor('.searchInput')
    const sharedInput = declarationsFor(
      '.text-input',
      'src/renderer/src/styles/navigation-controls.css'
    )

    assert.equal(searchInput.get('--text-input-pad-block'), '0')
    assert.equal(searchInput.get('--text-input-pad-inline-start'), '36px')
    assert.equal(searchInput.get('--text-input-pad-inline-end'), '66px')
    assert.equal(sharedInput.get('padding-block'), 'var(--text-input-pad-block, 8px)')
    assert.equal(
      sharedInput.get('padding-inline')?.replace(/\s+/g, ' '),
      'var(--text-input-pad-inline-start, 12px) var(--text-input-pad-inline-end, 12px)'
    )
  })

  it('centers the search icon inside the input control', () => {
    const declarations = declarationsFor('.searchIcon')

    assert.equal(declarations.get('position'), 'absolute')
    assert.equal(declarations.get('top'), '50%')
    assert.equal(declarations.get('transform'), 'translateY(-50%)')
  })

  it('keeps the keyboard shortcut on the same vertical center line', () => {
    const declarations = declarationsFor('.shortcut')

    assert.equal(declarations.get('position'), 'absolute')
    assert.equal(declarations.get('top'), '50%')
    assert.equal(declarations.get('transform'), 'translateY(-50%)')
  })
})
