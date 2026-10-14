// Shipped in the combined source bundle; needs only Node.js, not npm packages.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export function safePath(name) {
  assert.ok(typeof name === 'string' && name.length > 0 && !/[\\:\0]/.test(name)
    && name.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe source path')
  return name
}
export function materialBytes(root, record) {
  const parts = record.parts ?? [{ path: record.path, sha256: record.sha256 }]
  const bytes = Buffer.concat(parts.map(part => {
    const file = path.join(root, safePath(part.path))
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Missing source material')
    const bytes = fs.readFileSync(file)
    assert.equal(sha256(bytes), part.sha256, 'Source material digest mismatch')
    return bytes
  }))
  assert.equal(bytes.length, record.bytes, 'Source material size mismatch')
  assert.equal(sha256(bytes), record.sha256, 'Reconstructed source digest mismatch')
  return bytes
}
export function restorePlatform(root, target, destination) {
  safePath(target)
  assert.ok(!fs.existsSync(destination), 'Restore requires a new directory')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifests', target + '.json')))
  assert.equal(manifest.target, target)
  assert.equal(manifest.schemaVersion, 1)
  // Validate everything before creating the destination; never run build scripts.
  for (const [name, record] of Object.entries(manifest.materials)) {
    safePath(name)
    materialBytes(root, record)
  }
  fs.mkdirSync(destination, { recursive: true })
  for (const [name, record] of Object.entries(manifest.materials)) {
    const file = path.join(destination, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, materialBytes(root, record), { flag: 'wx', mode: record.mode })
    fs.chmodSync(file, record.mode)
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.dirname(fileURLToPath(import.meta.url))
  assert.equal(process.argv.length, 4, 'Usage: node restore.mjs <platform> <new-directory>')
  restorePlatform(root, process.argv[2], path.resolve(process.argv[3]))
}
