import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  findDuplicateTopLevelBindings,
  listTopLevelFunctions,
  replacePluginFunctionCode,
  replacePluginSnippetCode
} from './pluginDevCodeEdit'

const actressCode = `function extractMeta(text) {
  const zodiac = text.match(/星座[:：]\\s*([^\\n]+)/)?.[1]
  return { zodiac }
}

async function parseActress(ctx) {
  const html = await ctx.fetchPage('https://example.test')
  const meta = extractMeta(html)
  return { mainName: ctx.mainName, zodiac: meta.zodiac }
}

module.exports = { parseActress }`

describe('pluginDevCodeEdit', () => {
  it('replace_snippet swaps a unique fragment', () => {
    const next = replacePluginSnippetCode(
      'actress',
      actressCode,
      'const zodiac = text.match(/星座[:：]\\s*([^\\n]+)/)?.[1]',
      'const zodiac = text.match(/星座[:：]\\s*([^血]+)/)?.[1]?.trim()'
    )
    assert.match(next, /星座\[:：\]\\s\*\(\[\^血\]\+\)/)
    assert.doesNotMatch(next, /\[\^\\n\]\+/)
  })

  it('replace_snippet rejects non-unique oldText', () => {
    const code = 'const x = 1\nconst x = 2\n'
    assert.throws(
      () => replacePluginSnippetCode('video', code, 'const x', 'const y'),
      /不唯一/
    )
  })

  it('replace_snippet picks match nearest nearLine', () => {
    const code = `function a() {
  return 'OLD-A';
}
function b() {
  return 'OLD-B';
}
module.exports = { b };`
    const next = replacePluginSnippetCode('video', code, "return 'OLD-B'", "return 'NEW-B'", 5)
    assert.match(next, /function a[\s\S]*OLD-A/)
    assert.match(next, /function b[\s\S]*NEW-B/)
  })

  it('replace_function can replace a top-level helper', () => {
    const next = replacePluginFunctionCode(
      'actress',
      actressCode,
      'extractMeta',
      `function extractMeta(text) {
  const zodiac = text.match(/星座[:：]\\s*([^血]+)/)?.[1]?.trim()
  return { zodiac }
}`
    )
    assert.match(next, /\[\^血\]\+/)
    assert.equal(findDuplicateTopLevelBindings(next).length, 0)
    assert.doesNotMatch(next, /\[\^\\n\]\+/)
  })

  it('replace_function rejects re-declaring helper inside parseActress block', () => {
    assert.throws(
      () =>
        replacePluginFunctionCode(
          'actress',
          actressCode,
          'parseActress',
          `function extractMeta(text) {
  return { zodiac: 'Leo' }
}
async function parseActress(ctx) {
  return { mainName: ctx.mainName, zodiac: extractMeta('').zodiac }
}`
        ),
      /重复声明了 head 已有的顶层符号：extractMeta/
    )
  })

  it('listTopLevelFunctions returns names with line ranges', () => {
    const fns = listTopLevelFunctions(actressCode)
    assert.deepEqual(
      fns.map((item) => item.name),
      ['extractMeta', 'parseActress']
    )
    assert.ok(fns[0].startLine < fns[1].startLine)
  })

  it('findDuplicateTopLevelBindings detects duplicate function names', () => {
    const code = `function extractMeta() {}
async function parseActress() {}
function extractMeta() {}
module.exports = { parseActress }`
    assert.deepEqual(findDuplicateTopLevelBindings(code), ['extractMeta'])
  })
})
