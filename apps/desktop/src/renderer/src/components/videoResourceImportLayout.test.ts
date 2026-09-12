import { readFileSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(selector: string): Map<string, string> {
  const source = readFileSync(
    path.resolve('apps/desktop/src/renderer/src/styles/media-details.css'),
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

describe('video resource import layout', () => {
  it('gives the size value the fluid column and keeps its unit compact', () => {
    const declarations = declarationsFor('.video-resource-size-control')

    assert.equal(declarations.get('display'), 'grid')
    assert.equal(declarations.get('grid-template-columns'), 'minmax(0, 1fr) 88px')
  })
})
