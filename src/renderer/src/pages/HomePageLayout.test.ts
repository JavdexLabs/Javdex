import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(selector: string): Map<string, string> {
  const source = readFileSync(
    path.resolve('src/renderer/src/pages/HomePage.module.css'),
    'utf8'
  )
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
