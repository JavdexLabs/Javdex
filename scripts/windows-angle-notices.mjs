// Keep every supplier notice and its association with each component. Only
// byte-identical <pre> bodies are shared; the original document is recoverable.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const marker = 'JAVDEX-WINDOWS-ANGLE-NOTICE'
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex')
const referenceText = id => `This component has the identical complete notice ${marker}:${id}:original reproduced above. Search for this ID in this file.`
const markerPattern = new RegExp(`<!-- ${marker}:([0-9a-f]{64}):(original|reference) -->\\n<pre>([\\s\\S]*?)<\\/pre>`, 'g')

export function restoreWindowsAngleNotices(compact) {
  const originals = new Map()
  let blocks = 0, references = 0
  const restored = compact.replace(markerPattern, (_full, id, kind, body) => {
    blocks++
    if (kind === 'original') {
      assert.equal(hash(body), id, 'ANGLE notice content does not match its identifier')
      assert.ok(!originals.has(id), 'Duplicate original ANGLE notice identifier')
      originals.set(id, body)
      return `<pre>${body}</pre>`
    }
    assert.equal(body, referenceText(id), 'Invalid ANGLE notice reference')
    assert.ok(originals.has(id), 'ANGLE notice reference has no preceding original')
    references++
    return `<pre>${originals.get(id)}</pre>`
  })
  assert.ok(blocks > 0, 'No compact ANGLE notices found')
  assert.ok(!restored.includes(marker), 'Unexpected or malformed ANGLE notice marker')
  return { html: restored, blocks, unique: originals.size, references }
}

export function compactWindowsAngleNotices(html) {
  assert.ok(!html.includes(marker), 'Supplier notice unexpectedly contains the reserved marker')
  // Refuse unknown upstream structures instead of silently leaving an
  // incomplete or ambiguously transformed document.
  const openCount = (html.match(/<pre\b/gi) ?? []).length
  const closeCount = (html.match(/<\/pre\s*>/gi) ?? []).length
  const originals = new Map()
  let blocks = 0
  const compact = html.replace(/<pre>([\s\S]*?)<\/pre>/g, (_full, body) => {
    blocks++
    const id = hash(body)
    const existing = originals.get(id)
    if (existing !== undefined) {
      assert.equal(existing, body, 'ANGLE notice identifier collision')
      return `<!-- ${marker}:${id}:reference -->\n<pre>${referenceText(id)}</pre>`
    }
    originals.set(id, body)
    return `<!-- ${marker}:${id}:original -->\n<pre>${body}</pre>`
  })
  assert.ok(blocks > 0 && blocks === openCount && blocks === closeCount, 'Unsupported Chromium notice structure')
  const restored = restoreWindowsAngleNotices(compact)
  assert.equal(restored.html, html, 'Compact ANGLE notices must restore the exact supplier document')
  return { compact, blocks, unique: originals.size, references: restored.references, originalSha256: hash(html) }
}
