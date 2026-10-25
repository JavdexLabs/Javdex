import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const upstreamHash = '76120d3971051fcc469c0bfa36e7b23d3c388b6a2f5785bf1491bbdb90ff0176'
// Keep native Sharp for Node and other desktop platforms. Never load native
// libvips into Linux Electron: its GLib symbols can collide with Electron's.
const prefix = `// Javdex: Linux Electron uses the upstream WASM backend (sharp 0.35.5).
if (process.platform === 'linux' && process.versions.electron) {
  module.exports = require('@img/sharp-wasm32/sharp.node');
  return;
}

`

export function patchSharpSource(source) {
  const original = source.startsWith(prefix) ? source.slice(prefix.length) : source
  if (createHash('sha256').update(original).digest('hex') !== upstreamHash) {
    throw new Error('Sharp loader changed; review the Linux Electron backend patch before upgrading')
  }
  return prefix + original
}

export function prepareSharp(root = process.cwd(), { check = false } = {}) {
  const require = createRequire(join(root, 'package.json'))
  const entry = require.resolve('sharp')
  const sharpRoot = dirname(dirname(entry))
  const pkg = JSON.parse(readFileSync(join(sharpRoot, 'package.json'), 'utf8'))
  const sharpRequire = createRequire(entry)
  const wasm = sharpRequire('@img/sharp-wasm32/package')
  if (pkg.version !== '0.35.5' || wasm.version !== pkg.version) {
    throw new Error('Sharp and its WASM backend must both be pinned to 0.35.5')
  }
  const file = join(sharpRoot, 'dist/sharp.cjs')
  const source = readFileSync(file, 'utf8')
  const patched = patchSharpSource(source)
  if (check && source !== patched) throw new Error('Sharp Linux Electron patch missing; run npm run prepare:sharp')
  if (!check && source !== patched) writeFileSync(file, patched)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSharp(process.cwd(), { check: process.argv.includes('--check') })
}
