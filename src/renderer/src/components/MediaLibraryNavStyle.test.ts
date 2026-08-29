import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(selector: string): Map<string, string> {
  const source = readFileSync(
    path.resolve('src/renderer/src/components/MediaLibraryNav.module.css'),
    'utf8'
  )
  const declarations = new Map<string, string>()
  const root = postcss.parse(source)

  root.walkRules((rule) => {
    if (!rule.selector.split(',').map((item) => item.trim()).includes(selector)) return
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value)
    })
  })

  return declarations
}

describe('MediaLibraryNav name style', () => {
  it('keeps active and archived library names on one ellipsized line', () => {
    const declarations = declarationsFor('.name')

    assert.equal(declarations.get('overflow'), 'hidden')
    assert.equal(declarations.get('white-space'), 'nowrap')
    assert.equal(declarations.get('text-overflow'), 'ellipsis')

    const component = readFileSync(
      path.resolve('src/renderer/src/components/MediaLibraryNav.tsx'),
      'utf8'
    )
    assert.equal(component.match(/className=\{`nav-label \$\{styles\.name\}`\}/g)?.length, 2)
  })
})
