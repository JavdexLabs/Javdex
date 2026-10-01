import assert from 'node:assert/strict'
import { test } from 'node:test'
import { load } from './test-style-loader.mjs'

test('unit loader exposes a static PNG URL without treating it as JavaScript', async () => {
  const url = new URL('../build/icon-128.png', import.meta.url).href
  const result = await load(url, {}, () => assert.fail('PNG must not reach Node JavaScript loader'))
  assert.equal(result.format, 'module')
  assert.equal(result.shortCircuit, true)
  assert.equal(result.source, `export default ${JSON.stringify(url)}`)
})

test('unit loader delegates ordinary modules and unknown assets unchanged', async () => {
  for (const url of ['file:///module.tsx', 'file:///unknown.bin']) {
    const context = { format: 'module' }
    const expected = { source: 'original' }
    const result = await load(url, context, (actualUrl, actualContext) => {
      assert.equal(actualUrl, url)
      assert.equal(actualContext, context)
      return expected
    })
    assert.equal(result, expected)
  }
})
