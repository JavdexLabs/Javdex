import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactWindowsAngleNotices, restoreWindowsAngleNotices } from './windows-angle-notices.mjs'

const notice = '<html><div class="product">first<pre>Copyright A\nPermission A</pre></div>'
  + '<div class="product">second<pre>Copyright A\nPermission A</pre></div>'
  + '<div class="product">third<pre>Copyright B\nPermission A</pre></div></html>'

test('duplicate notice bodies are shared while every component and the exact supplier document remain recoverable', () => {
  const result = compactWindowsAngleNotices(notice)
  assert.deepEqual({ blocks: result.blocks, unique: result.unique, references: result.references }, { blocks: 3, unique: 2, references: 1 })
  assert.equal((result.compact.match(/Copyright A/g) ?? []).length, 1)
  const id = /JAVDEX-WINDOWS-ANGLE-NOTICE:([0-9a-f]{64}):original/.exec(result.compact)?.[0]
  assert.ok(id && result.compact.split(id).length >= 3, 'reference must contain the exact searchable original marker')
  for (const component of ['first', 'second', 'third']) assert.ok(result.compact.includes(component))
  assert.ok(result.compact.includes('Copyright B'))
  assert.equal(restoreWindowsAngleNotices(result.compact).html, notice)
})

test('similar but different notices stay separate', () => {
  const original = '<pre>Copyright A\nPermission A</pre><pre>Copyright A\nPermission A </pre>'
  const result = compactWindowsAngleNotices(original)
  assert.equal(result.unique, 2)
  assert.equal(result.references, 0)
  assert.equal(restoreWindowsAngleNotices(result.compact).html, original)
})

test('unexpected supplier structures and modified references are rejected', () => {
  assert.throws(() => compactWindowsAngleNotices('<pre class="license">x</pre>'), /Unsupported/)
  assert.throws(() => compactWindowsAngleNotices('<pre>x</pre>JAVDEX-WINDOWS-ANGLE-NOTICE'), /reserved marker/)
  const { compact } = compactWindowsAngleNotices(notice)
  assert.throws(() => restoreWindowsAngleNotices(compact.replace('identical complete notice', 'changed notice')), /Invalid ANGLE notice reference/)
  assert.throws(() => restoreWindowsAngleNotices(compact.replace('Copyright A', 'Copyright C')), /identifier/)
})
