import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(selector: string): Map<string, string> {
  const source = readFileSync(
    path.resolve('src/renderer/src/components/MediaLibraryCreateModal.module.css'),
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

describe('MediaLibraryCreateModal control style', () => {
  it('keeps all workflow steps at one viewport-safe dialog height', () => {
    const declarations = declarationsFor('.modal')

    assert.equal(
      declarations.get('height'),
      'min(760px, calc(100vh - var(--modal-viewport-inset)))'
    )

    const component = readFileSync(
      path.resolve('src/renderer/src/components/MediaLibraryCreateModal.tsx'),
      'utf8'
    )
    assert.match(component, /className=\{styles\.modal\}/)
  })

  it('reserves a visible gutter for the left edge of the focus ring', () => {
    const declarations = declarationsFor('.modalBody')

    assert.equal(
      declarations.get('margin-inline-start'),
      'calc(-1 * var(--scrollbar-safe-pad))'
    )
    assert.equal(declarations.get('padding-inline-start'), 'var(--scrollbar-safe-pad)')
  })
})
