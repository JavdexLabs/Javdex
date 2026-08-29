import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import postcss from 'postcss'

function declarationsFor(file: string, selector: string): Map<string, string> {
  const source = readFileSync(path.resolve(file), 'utf8')
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

describe('video detail library context layout', () => {
  it('shares the compact detail header row with the back action', () => {
    const header = declarationsFor(
      'src/renderer/src/components/DetailScrollBody.module.css',
      '.header'
    )
    const context = declarationsFor(
      'src/renderer/src/components/DetailScrollBody.module.css',
      '.headerContext'
    )

    assert.equal(header.get('display'), 'flex')
    assert.equal(header.get('align-items'), 'center')
    assert.equal(header.get('margin-bottom'), '12px')
    assert.equal(context.get('min-width'), '0')
    assert.equal(context.get('flex'), '1')
    assert.equal(context.get('overflow'), 'hidden')

    const detailPage = readFileSync(
      path.resolve('src/renderer/src/pages/DetailPage.tsx'),
      'utf8'
    )
    assert.match(
      detailPage,
      /<DetailScrollBody[\s\S]*?headerContext=\{[\s\S]*?<VideoLibraryMembershipBadges[\s\S]*?\}[\s\S]*?>\s*<article/
    )
    assert.equal(detailPage.match(/<VideoLibraryMembershipBadges/g)?.length, 1)
  })

  it('keeps membership badges on one bounded line', () => {
    const root = declarationsFor(
      'src/renderer/src/components/VideoLibraryMembershipBadges.module.css',
      '.root'
    )
    const name = declarationsFor(
      'src/renderer/src/components/VideoLibraryMembershipBadges.module.css',
      '.name'
    )

    assert.equal(root.get('max-width'), '100%')
    assert.equal(root.get('flex-wrap'), 'nowrap')
    assert.equal(root.get('overflow'), 'hidden')
    assert.equal(name.get('min-width'), '0')
    assert.equal(name.get('text-overflow'), 'ellipsis')
  })
})
