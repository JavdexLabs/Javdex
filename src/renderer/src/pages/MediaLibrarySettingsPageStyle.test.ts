import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(selector: string): Map<string, string> {
  const source = readFileSync(
    path.resolve('src/renderer/src/pages/MediaLibrarySettingsPage.module.css'),
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

describe('MediaLibrarySettingsPage layout', () => {
  it('uses the application settings width token and stays left aligned', () => {
    const declarations = declarationsFor('.page')

    assert.equal(declarations.get('width'), '100%')
    assert.equal(declarations.get('max-width'), 'var(--settings-content-max)')
    assert.equal(declarations.get('margin'), '0')
  })
})
